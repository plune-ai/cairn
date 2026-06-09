import { describe, it, expect } from "vitest";
import { z } from "zod";
import { retryInvoke, CallBudget, cappedInvoke } from "../../src/llm/structured.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";

const S = z.object({ ok: z.boolean() });

describe("retryInvoke (Sprint 6 robustness)", () => {
  it("retries a transient error (429) → eventually succeeds", async () => {
    let calls = 0;
    const inner: StructuredInvoke = async (schema) => {
      calls += 1;
      if (calls < 3) throw new Error("429 Too Many Requests");
      return schema.parse({ ok: true });
    };
    const r = await retryInvoke(inner, { baseDelayMs: 0 })(S, []);
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("a non-transient error (validation) throws immediately, without retry", async () => {
    let calls = 0;
    const inner: StructuredInvoke = async () => {
      calls += 1;
      throw new Error("schema validation failed");
    };
    await expect(retryInvoke(inner, { baseDelayMs: 0 })(S, [])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("exhausts retries → throws (1 + N attempts)", async () => {
    let calls = 0;
    const inner: StructuredInvoke = async () => {
      calls += 1;
      throw new Error("503 overloaded");
    };
    await expect(retryInvoke(inner, { retries: 2, baseDelayMs: 0 })(S, [])).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("CallBudget/cappedInvoke: throws when the call limit is exceeded", async () => {
    const inner: StructuredInvoke = async (schema) => schema.parse({ ok: true });
    const budget = new CallBudget(2);
    const capped = cappedInvoke(inner, budget);
    await capped(S, []);
    await capped(S, []);
    await expect(capped(S, [])).rejects.toThrow(/limit/);
    expect(budget.spent).toBe(3);
  });
});
