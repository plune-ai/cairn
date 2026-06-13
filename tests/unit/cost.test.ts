import { describe, it, expect } from "vitest";
import { CostLedger, extractUsage, priceFor, DEFAULT_PRICING } from "../../src/llm/cost.js";

const PRICES = {
  "m-cheap": { inputPer1M: 1, outputPer1M: 2 },
  "m-pricey": { inputPer1M: 10, outputPer1M: 30 },
};

describe("priceFor", () => {
  it("known model → price; unknown → undefined", () => {
    expect(priceFor("m-cheap", PRICES)).toEqual({ inputPer1M: 1, outputPer1M: 2 });
    expect(priceFor("nope", PRICES)).toBeUndefined();
  });
  it("default table prices the Anthropic profile models (claude-api skill)", () => {
    expect(priceFor("claude-opus-4-8", DEFAULT_PRICING)).toEqual({ inputPer1M: 5, outputPer1M: 25 });
    expect(priceFor("claude-sonnet-4-6", DEFAULT_PRICING)).toEqual({ inputPer1M: 3, outputPer1M: 15 });
    expect(priceFor("claude-haiku-4-5", DEFAULT_PRICING)).toEqual({ inputPer1M: 1, outputPer1M: 5 });
  });
  it("default table prices the Groq fast-preset worker (L1-02, approximate/movable)", () => {
    expect(priceFor("llama-3.3-70b-versatile", DEFAULT_PRICING)).toEqual({ inputPer1M: 0.59, outputPer1M: 0.79 });
  });
  it("unknown Groq model → undefined price (graceful; tokens still counted, ADR-0002)", () => {
    expect(priceFor("groq/does-not-exist", DEFAULT_PRICING)).toBeUndefined();
  });
});

describe("extractUsage — reads usage off a LangChain message, never throws", () => {
  it("reads usage_metadata (LangChain-normalized)", () => {
    expect(extractUsage({ usage_metadata: { input_tokens: 100, output_tokens: 40 } })).toEqual({
      inputTokens: 100,
      outputTokens: 40,
    });
  });
  it("falls back to response_metadata.usage (OpenAI/OpenRouter shape)", () => {
    expect(extractUsage({ response_metadata: { usage: { prompt_tokens: 7, completion_tokens: 3 } } })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    });
  });
  it("response_metadata.usage with input_tokens/output_tokens (Anthropic-via-LC shape)", () => {
    expect(extractUsage({ response_metadata: { usage: { input_tokens: 9, output_tokens: 4 } } })).toEqual({
      inputTokens: 9,
      outputTokens: 4,
    });
  });
  it("response_metadata.tokenUsage (camelCase fallback)", () => {
    expect(extractUsage({ response_metadata: { tokenUsage: { promptTokens: 11, completionTokens: 6 } } })).toEqual({
      inputTokens: 11,
      outputTokens: 6,
    });
  });
  it("partial usage_metadata (only input) → output zero", () => {
    expect(extractUsage({ usage_metadata: { input_tokens: 8 } })).toEqual({ inputTokens: 8, outputTokens: 0 });
  });
  it("missing usage → zeros", () => {
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(extractUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("CostLedger — per-role attribution sums correctly", () => {
  it("sums tokens + cost per role across calls", () => {
    const led = new CostLedger(PRICES);
    led.record("worker", "m-cheap", { inputTokens: 1_000_000, outputTokens: 500_000 }); // 1*1 + 0.5*2 = 2
    led.record("worker", "m-cheap", { inputTokens: 1_000_000, outputTokens: 0 }); // +1 = 3
    led.record("reasoner", "m-pricey", { inputTokens: 100_000, outputTokens: 100_000 }); // 0.1*10 + 0.1*30 = 4
    const rep = led.report();

    const worker = rep.perRole.find((r) => r.role === "worker");
    expect(worker?.calls).toBe(2);
    expect(worker?.inputTokens).toBe(2_000_000);
    expect(worker?.outputTokens).toBe(500_000);
    expect(worker?.totalTokens).toBe(2_500_000);
    expect(worker?.costUsd).toBeCloseTo(3, 6);

    const reasoner = rep.perRole.find((r) => r.role === "reasoner");
    expect(reasoner?.costUsd).toBeCloseTo(4, 6);

    expect(rep.totalTokens).toBe(2_700_000);
    expect(rep.totalCostUsd).toBeCloseTo(7, 6);
  });

  it("orders roles worker, reasoner, judge", () => {
    const led = new CostLedger(PRICES);
    led.record("judge", "m-cheap", { inputTokens: 1, outputTokens: 1 });
    led.record("reasoner", "m-cheap", { inputTokens: 1, outputTokens: 1 });
    led.record("worker", "m-cheap", { inputTokens: 1, outputTokens: 1 });
    expect(led.report().perRole.map((r) => r.role)).toEqual(["worker", "reasoner", "judge"]);
  });

  it("unknown model price → role costUsd null + total null; tokens still counted (graceful, ADR-0002)", () => {
    const led = new CostLedger(PRICES);
    led.record("worker", "mystery/model", { inputTokens: 1000, outputTokens: 1000 });
    led.record("reasoner", "m-pricey", { inputTokens: 1_000_000, outputTokens: 0 }); // 10
    const rep = led.report();

    const worker = rep.perRole.find((r) => r.role === "worker");
    expect(worker?.costUsd).toBeNull();
    expect(worker?.inputTokens).toBe(1000);
    expect(worker?.models).toEqual(["mystery/model"]);

    const reasoner = rep.perRole.find((r) => r.role === "reasoner");
    expect(reasoner?.costUsd).toBeCloseTo(10, 6); // known prices still computed per-role

    expect(rep.totalCostUsd).toBeNull(); // any unknown → total unknown
    expect(rep.totalTokens).toBe(1_002_000);
  });
});
