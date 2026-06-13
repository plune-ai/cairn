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

  it("CallBudget exposes max + remaining so a run can surface it (L1-04, Box 3)", () => {
    const b = new CallBudget(80);
    expect(b.max).toBe(80);
    expect(b.spent).toBe(0);
    expect(b.remaining).toBe(80);
    b.charge();
    b.charge();
    expect(b.spent).toBe(2);
    expect(b.remaining).toBe(78);
  });

  it("CallBudget.remaining never goes negative once the cap trips", () => {
    const b = new CallBudget(1);
    b.charge();
    expect(() => b.charge()).toThrow(/budget|limit/i);
    expect(b.remaining).toBe(0); // spent=2, max=1 → clamped to 0
  });

  it("cappedInvoke fires onCharge after each successful charge, not when it trips (L1-04, Box 3)", async () => {
    const inner: StructuredInvoke = async (schema) => schema.parse({ ok: true });
    const budget = new CallBudget(2);
    const seen: Array<[number, number]> = [];
    const capped = cappedInvoke(inner, budget, (used, max) => seen.push([used, max]));
    await capped(S, []);
    await capped(S, []);
    await expect(capped(S, [])).rejects.toThrow();
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]); // never called for the 3rd (over-cap) call
  });
});
