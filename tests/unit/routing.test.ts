import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { meteredInvoker, structuredInvoker, CallBudget } from "../../src/llm/structured.js";
import { resolveRoleTier, RoleRouter, KNOWN_ROLES } from "../../src/llm/routing.js";
import type { AppConfig, ModelTier } from "../../src/config/index.js";

const vision: ModelTier = { provider: "anthropic", model: "claude-haiku-4-5", supportsVision: true };
const bulk: ModelTier = { provider: "anthropic", model: "claude-sonnet-4-6", supportsVision: false };
const okSchema = z.object({ ok: z.number() });

/** Minimal fake BaseChatModel whose structured call returns {raw, parsed}. */
function fakeModel(parsed: unknown, raw: unknown): BaseChatModel {
  return {
    withStructuredOutput: () => ({ invoke: async () => ({ raw, parsed }) }),
  } as unknown as BaseChatModel;
}

/** Fake that records the options passed to withStructuredOutput (to assert the structured method). */
function recordingModel(parsed: unknown, raw: unknown, sink: { opts?: unknown }): BaseChatModel {
  return {
    withStructuredOutput: (_schema: unknown, opts?: { includeRaw?: boolean; method?: string }) => {
      sink.opts = opts;
      // Mirror LangChain: includeRaw → {raw, parsed}; otherwise the parsed value directly.
      return { invoke: async () => (opts?.includeRaw ? { raw, parsed } : parsed) };
    },
  } as unknown as BaseChatModel;
}

describe("meteredInvoker", () => {
  it("returns the parsed result AND reports usage to the callback", async () => {
    const seen: Array<{ usage: unknown; model: string }> = [];
    const model = fakeModel({ ok: 1 }, { usage_metadata: { input_tokens: 12, output_tokens: 5 } });
    const invoke = meteredInvoker(model, (usage, m) => seen.push({ usage, model: m }), "deepseek/deepseek-chat");
    const out = await invoke(okSchema, []);
    expect(out).toEqual({ ok: 1 });
    expect(seen).toEqual([{ usage: { inputTokens: 12, outputTokens: 5 }, model: "deepseek/deepseek-chat" }]);
  });

  it("a throwing usage callback never breaks the call", async () => {
    const model = fakeModel({ ok: 2 }, {});
    const invoke = meteredInvoker(
      model,
      () => {
        throw new Error("boom");
      },
      "m",
    );
    await expect(invoke(okSchema, [])).resolves.toEqual({ ok: 2 });
  });
});

describe("resolveRoleTier — override ?? fallback (backward-compat)", () => {
  it("no routing → returns the fallback tier unchanged", () => {
    expect(resolveRoleTier("worker", vision, undefined)).toBe(vision);
  });
  it("override present → returns the override tier", () => {
    const ovr: ModelTier = { provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false };
    expect(resolveRoleTier("worker", vision, { worker: ovr })).toBe(ovr);
  });
  it("KNOWN_ROLES is worker + reasoner only (judge is not routable)", () => {
    expect([...KNOWN_ROLES]).toEqual(["worker", "reasoner"]);
  });
});

describe("RoleRouter — meters per role, falls back per tier", () => {
  const baseCfg = {
    llmProfile: "anthropic",
    models: { reasoning: bulk, bulk, judge: bulk, vision },
    langfuse: { enabled: false },
    browser: { backend: "lib" },
    maxRepair: 0,
    testCaseLanguage: "English",
  } as unknown as AppConfig;

  it("tierFor resolves the override for a routed role", () => {
    const cfg = { ...baseCfg, roles: { worker: { provider: "openrouter", model: "x", supportsVision: false } } } as AppConfig;
    const router = new RoleRouter(cfg, { anthropicApiKey: "k", openrouterApiKey: "k" }, new CallBudget(80));
    expect(router.tierFor("worker", vision).model).toBe("x");
    expect(router.tierFor("reasoner", bulk).model).toBe(bulk.model); // no override → fallback
  });

  it("invoke meters usage under the named role via the injected model factory", async () => {
    const fake = () => fakeModel({ ok: 1 }, { usage_metadata: { input_tokens: 4, output_tokens: 2 } });
    const router = new RoleRouter(
      baseCfg,
      { anthropicApiKey: "k" },
      new CallBudget(80),
      undefined,
      fake,
    );
    const inv = router.invoke("reasoner", bulk);
    await inv(okSchema, []);
    const reasoner = router.ledger.report().perRole.find((r) => r.role === "reasoner");
    expect(reasoner?.calls).toBe(1);
    expect(reasoner?.inputTokens).toBe(4);
    expect(reasoner?.outputTokens).toBe(2);
  });

  it("invoke routes a Groq tier through functionCalling (structured-output fix, L1-02)", async () => {
    const sink: { opts?: unknown } = {};
    const groqTier: ModelTier = { provider: "groq", model: "llama-3.3-70b-versatile", supportsVision: false };
    const router = new RoleRouter(
      baseCfg,
      { groqApiKey: "k", anthropicApiKey: "k" },
      new CallBudget(80),
      undefined,
      () => recordingModel({ ok: 1 }, { usage_metadata: { input_tokens: 1, output_tokens: 1 } }, sink),
    );
    await router.invoke("worker", groqTier)(okSchema, []);
    expect(sink.opts).toMatchObject({ method: "functionCalling" });
  });
});

describe("RoleRouter — callbacks binding (Task 2 telemetry rebind)", () => {
  const baseCfg = {
    llmProfile: "anthropic",
    models: { reasoning: bulk, bulk, judge: bulk, vision },
    langfuse: { enabled: false },
    browser: { backend: "lib" },
    maxRepair: 0,
    testCaseLanguage: "English",
  } as unknown as AppConfig;

  it("threads the sentinel callbacks array through to the LLM invoke config", async () => {
    const sentinel = [{ name: "sentinel-handler" }];
    const recordedConfigs: unknown[] = [];

    /** Fake model whose invoke records the config arg passed from meteredInvoker. */
    function configRecordingModel(parsed: unknown, raw: unknown): BaseChatModel {
      return {
        withStructuredOutput: (_schema: unknown, opts?: { includeRaw?: boolean; method?: string }) => ({
          invoke: async (_messages: unknown, config?: unknown) => {
            recordedConfigs.push(config);
            return opts?.includeRaw ? { raw, parsed } : parsed;
          },
        }),
      } as unknown as BaseChatModel;
    }

    const router = new RoleRouter(
      baseCfg,
      { anthropicApiKey: "k" },
      new CallBudget(80),
      undefined,
      () => configRecordingModel({ ok: 1 }, { usage_metadata: { input_tokens: 1, output_tokens: 1 } }),
      undefined,
      sentinel,
    );

    const inv = router.invoke("worker", bulk);
    await inv(z.object({ ok: z.number() }), []);

    expect(recordedConfigs).toHaveLength(1);
    expect((recordedConfigs[0] as { callbacks: unknown[] }).callbacks).toBe(sentinel);
  });

  it("passes undefined config when no callbacks are given (backward-compat)", async () => {
    const recordedConfigs: unknown[] = [];

    function configRecordingModel(parsed: unknown, raw: unknown): BaseChatModel {
      return {
        withStructuredOutput: (_schema: unknown, opts?: { includeRaw?: boolean }) => ({
          invoke: async (_messages: unknown, config?: unknown) => {
            recordedConfigs.push(config);
            return opts?.includeRaw ? { raw, parsed } : parsed;
          },
        }),
      } as unknown as BaseChatModel;
    }

    const router = new RoleRouter(
      baseCfg,
      { anthropicApiKey: "k" },
      new CallBudget(80),
      undefined,
      () => configRecordingModel({ ok: 1 }, {}),
    );

    await router.invoke("worker", bulk)(z.object({ ok: z.number() }), []);
    expect(recordedConfigs[0]).toBeUndefined();
  });
});

describe("structured-output method forwarding (L1-02 Groq fix)", () => {
  it("meteredInvoker forwards the method into withStructuredOutput alongside includeRaw", async () => {
    const sink: { opts?: unknown } = {};
    const model = recordingModel({ ok: 1 }, { usage_metadata: { input_tokens: 1, output_tokens: 1 } }, sink);
    await meteredInvoker(model, () => undefined, "llama-3.3-70b-versatile", "functionCalling")(okSchema, []);
    expect(sink.opts).toMatchObject({ includeRaw: true, method: "functionCalling" });
  });

  it("meteredInvoker omits method when none is given (default behavior unchanged)", async () => {
    const sink: { opts?: unknown } = {};
    const model = recordingModel({ ok: 1 }, {}, sink);
    await meteredInvoker(model, () => undefined, "m")(okSchema, []);
    expect(sink.opts).toEqual({ includeRaw: true });
  });

  it("structuredInvoker forwards the method and returns the parsed result", async () => {
    const sink: { opts?: unknown } = {};
    const model = recordingModel({ ok: 7 }, {}, sink);
    const out = await structuredInvoker(model, "functionCalling")(okSchema, []);
    expect(out).toEqual({ ok: 7 });
    expect(sink.opts).toEqual({ method: "functionCalling" });
  });

  it("structuredInvoker without a method keeps the LangChain default call", async () => {
    const sink: { opts?: unknown } = {};
    const model = recordingModel({ ok: 9 }, {}, sink);
    const out = await structuredInvoker(model)(okSchema, []);
    expect(out).toEqual({ ok: 9 });
    expect(sink.opts).toBeUndefined();
  });
});
