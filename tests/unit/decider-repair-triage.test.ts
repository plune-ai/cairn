import { describe, it, expect, vi } from "vitest";
import { FAILURE_CATEGORIES, TRIAGE_QUESTION, makeTriage, triageState } from "../../src/decider/uses/repair-triage.js";
import { CAPS, checkCaps, questionChars } from "../../src/decider/capabilities.js";
import { makeDecider } from "../../src/decider/index.js";
import { secretValues } from "../../src/decider/redact.js";
import { CostLedger } from "../../src/llm/cost.js";
import {
  DeciderUnavailable,
  type Answer,
  type Decider,
  type DeciderConfig,
  type Question,
  type ShadowEntry,
} from "../../src/decider/types.js";
import type { TestResult } from "../../src/validate/index.js";

/** A scripted decider: `answer(state)` decides per failed test; every call is captured. */
function fakeDecider(
  answer: (state: string) => Answer | Error,
  over: { minConfidence?: number; shadow?: boolean } = {},
) {
  const calls: { use: string; state: string; questions: Record<string, Question> }[] = [];
  const entries: ShadowEntry[] = [];
  const decider: Decider = {
    provider: "laya",
    model: "jev-latest",
    caps: { maxInputChars: 1200, maxQuestionChars: 400, maxOptions: 20, maxQuestionsPerCall: 16 },
    uses: new Set(["repair-triage"]),
    minConfidence: over.minConfidence ?? 0.75,
    scrub: (t: string) => t,
    ...(over.shadow ? { shadow: { entries, record: (e: ShadowEntry) => void entries.push(e) } } : {}),
    summary: () => ({ provider: "laya", model: "jev-latest", calls: calls.length, fallbacks: [] }),
    async decide(use, state, questions) {
      calls.push({ use, state, questions: questions as Record<string, Question> });
      const a = answer(state);
      if (a instanceof Error) throw a;
      return Object.fromEntries(Object.keys(questions).map((k) => [k, a])) as never;
    },
  };
  return { decider, calls, entries };
}
const choice = (value: string, confidence: number): Answer => ({ type: "choice", value, dist: { [value]: 1 }, confidence });
const failed = (test: string, error?: string): TestResult => ({ test, status: "failed", ...(error ? { error } : {}) });
const same = (t: string): string => t;

describe("repair-triage (spec §6.1)", () => {
  it("asks one six-way choice per failed test, each over its own state: the name and the error", async () => {
    const { decider, calls } = fakeDecider(() => choice("timing", 0.9));
    await makeTriage(decider)([failed("TC-1", "Timeout 5000ms exceeded"), failed("TC-2", "resolved to 3 elements")]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.use).toBe("repair-triage");
    expect(calls[0]!.state).toBe('Playwright test "TC-1" failed.\nError:\nTimeout 5000ms exceeded');
    const q = Object.values(calls[1]!.questions)[0]!;
    expect(q.type).toBe("choice");
    expect(q.type === "choice" && Object.keys(q.options)).toEqual(Object.keys(FAILURE_CATEGORIES));
    expect(Object.keys(FAILURE_CATEGORIES)).toEqual([
      "locator-ambiguous",
      "locator-missing",
      "timing",
      "wrong-assertion",
      "app-bug",
      "env-or-session",
    ]);
  });

  it("a confident app-bug or env-or-session is excluded; any other confident category is only a hint", async () => {
    const byTest: Record<string, Answer> = { A: choice("app-bug", 0.9), B: choice("env-or-session", 0.8), C: choice("timing", 0.95) };
    const { decider } = fakeDecider((s) => byTest[/"(\w)"/.exec(s)![1]!]!);
    const out = await makeTriage(decider)([failed("A", "500"), failed("B", "login"), failed("C", "slow")]);
    expect(out).toEqual([
      { test: "A", category: "app-bug", confidence: 0.9, exclude: true },
      { test: "B", category: "env-or-session", confidence: 0.8, exclude: true },
      { test: "C", category: "timing", confidence: 0.95, exclude: false },
    ]);
  });

  it("ASYMMETRY: an app-bug answer below the threshold excludes nothing and tags nothing", async () => {
    const { decider } = fakeDecider(() => choice("app-bug", 0.5), { minConfidence: 0.75 });
    expect(await makeTriage(decider)([failed("A", "500 Internal Server Error")])).toEqual([]);
  });

  it("a decider that fails leaves every test to repair as today — and never throws", async () => {
    const { decider } = fakeDecider(() => new DeciderUnavailable("HTTP 500", 500));
    expect(await makeTriage(decider)([failed("A", "x"), failed("B", "y")])).toEqual([]);
    const weird = fakeDecider(() => new TypeError("boom"));
    expect(await makeTriage(weird.decider)([failed("A", "x")])).toEqual([]);
  });

  it("a label the decider was never offered is ignored, not trusted", async () => {
    const { decider } = fakeDecider(() => choice("skip-this-test", 0.99));
    expect(await makeTriage(decider)([failed("A", "x")])).toEqual([]);
  });

  it("the state fits the provider's cap: the error is clipped, never the whole call refused", () => {
    const s = triageState(failed("TC-1", "e".repeat(5000)), 300, same);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s.startsWith('Playwright test "TC-1" failed.\nError:\neee')).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(triageState(failed("TC-2"), 300, same)).toBe('Playwright test "TC-2" failed.\nError:\n(no error message)');
  });

  it("a secret the clip would cut in half is scrubbed first — no fragment of it is sent or recorded", async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_url: unknown, init: { body: string }) => {
      bodies.push(init.body);
      const answers = { cause: { type: "choice", choice: "timing", probabilities: { timing: 0.9 }, confidence: 0.9 } };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg: DeciderConfig = {
      provider: "compat",
      baseUrl: "http://127.0.0.1:9",
      model: "jev-latest",
      uses: ["repair-triage"],
      minConfidence: 0.75,
      timeoutMs: 1000,
      maxCalls: 10,
      shadow: true,
    };
    const d = makeDecider(cfg, { ledger: new CostLedger(), fetchFn, secrets: secretValues("Admin password: Sup3rS3cret!", {}) })!;
    const maxChars = CAPS.compat.maxInputChars - questionChars(TRIAGE_QUESTION);
    const head = 'Playwright test "logs in" failed.\nError:\n';
    // Clipped raw, the state would end in "Sup3rS3c…" — eight characters of the secret, no longer the secret.
    const error = `${"x".repeat(maxChars - 1 - head.length - 8)}Sup3rS3cret! was typed into Password`;
    await makeTriage(d)([failed("logs in", error)]);
    const sent = (JSON.parse(bodies[0]!) as { state: string }).state;
    expect(sent).not.toMatch(/Sup3r/);
    expect(sent.length).toBeLessThanOrEqual(maxChars);
    expect(String(d.shadow!.entries[0]!.input)).not.toMatch(/Sup3r/);
  });

  it("the real question and the longest state it builds pass laya's own caps — a fallback never comes from our own size", async () => {
    expect(questionChars(TRIAGE_QUESTION)).toBeLessThanOrEqual(CAPS.laya.maxQuestionChars);
    const base = fakeDecider(() => choice("timing", 0.9)).decider;
    const sent: string[] = [];
    const laya: Decider = {
      ...base,
      caps: CAPS.laya,
      async decide(use, state, questions) {
        checkCaps(CAPS.laya, state, questions as Record<string, Question>); // throws on anything laya would cut
        sent.push(state);
        return base.decide(use, state, questions);
      },
    };
    expect(await makeTriage(laya)([failed("TC-1", "e".repeat(5000))])).toHaveLength(1);
    expect(sent[0]!.length + questionChars(TRIAGE_QUESTION)).toBe(CAPS.laya.maxInputChars); // the whole budget, no more
  });

  it("terminal colour codes in Playwright's error are stripped from the state", () => {
    expect(triageState(failed("T", "\u001b[31mexpect(locator)\u001b[39m.toBeVisible()"), 300, same)).toContain(
      "expect(locator).toBeVisible()",
    );
  });

  it("the state never exceeds the provider cap even for a long test name", () => {
    const s = triageState(failed("N".repeat(400), "err"), 300, same);
    expect(s.length).toBeLessThanOrEqual(300);
  });

  it("shadow: every failed test is asked and recorded next to 'repair' — and nothing is excluded or tagged", async () => {
    const { decider, entries } = fakeDecider((s) => (s.includes('"A"') ? choice("app-bug", 0.9) : new DeciderUnavailable("timeout after 10 ms")), {
      shadow: true,
    });
    expect(await makeTriage(decider)([failed("A", "500"), failed("B", "slow")])).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        use: "repair-triage",
        current: "repair",
        decider: { category: "app-bug", confidence: 0.9, wouldExclude: true },
        confidence: 0.9,
      }),
      expect.objectContaining({ use: "repair-triage", current: "repair", decider: { unavailable: "timeout after 10 ms" } }),
    ]);
    expect(entries[0]!.input).toContain('"A"');
    expect(entries.every((e) => e.agreement === undefined)).toBe(true); // §9.3: agreement proves nothing here
    expect(entries.every((e) => typeof e.latencyMs === "number")).toBe(true);
  });

  it("shadow: a below-threshold answer is recorded as would-not-exclude", async () => {
    const { decider, entries } = fakeDecider(() => choice("app-bug", 0.4), { shadow: true });
    await makeTriage(decider)([failed("A", "500")]);
    expect(entries[0]!.decider).toEqual({ category: "app-bug", confidence: 0.4, wouldExclude: false });
  });

  it("runs the failed tests' calls concurrently, so a hanging server costs one timeout, not one per test", async () => {
    let inFlight = 0;
    let peak = 0;
    const decider = fakeDecider(() => choice("timing", 0.9)).decider;
    const slow: Decider = {
      ...decider,
      decide: vi.fn(async (...args: Parameters<Decider["decide"]>) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return decider.decide(...args);
      }) as Decider["decide"],
    };
    await makeTriage(slow)([failed("A", "x"), failed("B", "y"), failed("C", "z")]);
    expect(peak).toBe(3);
  });
});
