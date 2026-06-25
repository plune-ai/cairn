import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { timeoutInvoke, DEFAULT_STEP_TIMEOUT_MS, CallBudget } from "../../src/llm/structured.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import { RoleRouter } from "../../src/llm/routing.js";
import type { AppConfig, ModelTier } from "../../src/config/index.js";

const S = z.object({ ok: z.boolean() });

describe("timeoutInvoke (#110 — per-step timeout)", () => {
  it("DEFAULT_STEP_TIMEOUT_MS is 4 min (lets a healthy Anthropic step through, cuts a provider hang)", () => {
    expect(DEFAULT_STEP_TIMEOUT_MS).toBe(240000);
  });

  it("disabled (0 / negative / undefined) → returns inner unchanged, no overhead", () => {
    const inner: StructuredInvoke = async (schema) => schema.parse({ ok: true });
    expect(timeoutInvoke(inner, { timeoutMs: 0 })).toBe(inner);
    expect(timeoutInvoke(inner, { timeoutMs: -5 })).toBe(inner);
    expect(timeoutInvoke(inner, {})).toBe(inner);
    expect(timeoutInvoke(inner)).toBe(inner);
  });

  it("a fast inner resolves normally and the timer is cleared (no hang)", async () => {
    const inner: StructuredInvoke = async (schema) => schema.parse({ ok: true });
    const guarded = timeoutInvoke(inner, { timeoutMs: 10000 });
    await expect(guarded(S, [])).resolves.toEqual({ ok: true });
  });

  it("a slow inner overruns the timeout → throws ONE actionable error (does not hang)", async () => {
    vi.useFakeTimers();
    try {
      const inner: StructuredInvoke = () => new Promise(() => undefined); // never settles
      const guarded = timeoutInvoke(inner, {
        timeoutMs: 1000,
        label: "role 'reasoner', model 'deepseek/deepseek-r1'",
      });
      const p = guarded(S, []);
      const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timeout error is actionable: names the faster routing, the Anthropic profile, STEP_TIMEOUT_MS, and the step label", async () => {
    vi.useFakeTimers();
    try {
      const inner: StructuredInvoke = () => new Promise(() => undefined);
      const guarded = timeoutInvoke(inner, {
        timeoutMs: 500,
        label: "role 'worker', model 'deepseek/deepseek-chat'",
      });
      const p = guarded(S, []);
      const captured = p.catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      await vi.advanceTimersByTimeAsync(500);
      const msg = await captured;
      expect(msg).toMatch(/volume-fast/); // points at the latency-safe escape…
      expect(msg).toMatch(/LLM_PROFILE=anthropic/); // …or Anthropic
      expect(msg).toMatch(/STEP_TIMEOUT_MS/); // …or raising the cap
      expect(msg).toContain("role 'worker', model 'deepseek/deepseek-chat'"); // which step timed out
      expect(msg).not.toMatch(/Groq|--routing fast\b/); // NOT the Groq escape (400s on large codegen)
    } finally {
      vi.useRealTimers();
    }
  });

  it("a losing inner that rejects AFTER the timeout does not surface as an unhandled rejection", async () => {
    vi.useFakeTimers();
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const inner: StructuredInvoke = () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("late provider error")), 2000));
      const guarded = timeoutInvoke(inner, { timeoutMs: 1000 });
      const p = guarded(S, []);
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000); // timeout fires first
      await assertion;
      await vi.advanceTimersByTimeAsync(1000); // inner rejects late — must be swallowed
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
    expect(unhandled).toBeUndefined();
  });
});

describe("RoleRouter — wires the per-step timeout from cfg.stepTimeoutMs (#110)", () => {
  const bulk: ModelTier = { provider: "anthropic", model: "claude-sonnet-4-6", supportsVision: false };
  const vision: ModelTier = { provider: "anthropic", model: "claude-haiku-4-5", supportsVision: true };

  /** Fake model whose structured invoke never settles (simulates a pathologically slow provider). */
  function hangingModel(): BaseChatModel {
    return {
      withStructuredOutput: () => ({ invoke: () => new Promise(() => undefined) }),
    } as unknown as BaseChatModel;
  }

  function cfgWithTimeout(stepTimeoutMs: number): AppConfig {
    return {
      llmProfile: "anthropic",
      models: { reasoning: bulk, bulk, judge: bulk, vision },
      langfuse: { enabled: false },
      browser: { backend: "lib" },
      maxRepair: 0,
      testCaseLanguage: "English",
      stepTimeoutMs,
    } as unknown as AppConfig;
  }

  it("a hanging provider call rejects with the actionable timeout error instead of never resolving", async () => {
    vi.useFakeTimers();
    try {
      const router = new RoleRouter(cfgWithTimeout(800), { anthropicApiKey: "k" }, new CallBudget(80), undefined, () =>
        hangingModel(),
      );
      const p = router.invoke("reasoner", bulk)(S, []);
      const assertion = expect(p).rejects.toThrow(/timed out after 800ms.*role 'reasoner', model 'claude-sonnet-4-6'/s);
      await vi.advanceTimersByTimeAsync(800);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stepTimeoutMs=0 disables the timeout — a fast call still resolves (no regression for healthy providers)", async () => {
    const okModel = {
      withStructuredOutput: () => ({ invoke: async () => ({ raw: {}, parsed: { ok: true } }) }),
    } as unknown as BaseChatModel;
    const router = new RoleRouter(cfgWithTimeout(0), { anthropicApiKey: "k" }, new CallBudget(80), undefined, () => okModel);
    await expect(router.invoke("worker", bulk)(S, [])).resolves.toEqual({ ok: true });
  });
});
