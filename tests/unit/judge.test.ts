import { describe, it, expect, vi } from "vitest";
import { judgeTestCases, judgeChecklistCoverage, checklistCoverageScore } from "../../src/eval/judge.js";
import { coverageScore } from "../../src/checklist/index.js";
import { DeciderUnavailable, type Answer, type Decider, type ShadowEntry } from "../../src/decider/types.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { TestCase } from "../../src/design/index.js";

const tc: TestCase = {
  id: "tc-1",
  title: "Логін валідними даними",
  technique: "equivalence-partitioning",
  preconditions: [],
  steps: ["Ввести email", "Натиснути Sign In"],
  expected: "Успіх",
  priority: "high",
  elementRefs: ["e3"],
};

describe("judgeTestCases (SDK-side LLM judge)", () => {
  it("→ scores test_case_quality + methodology_adherence; prompt contains the cases", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ test_case_quality: 0.8, methodology_adherence: 0.7, comment: "ок" });
    };
    const scores = await judgeTestCases([tc], "Форма логіну", fakeInvoke, new PromptRegistry());
    expect(scores.find((s) => s.name === "test_case_quality")?.value).toBe(0.8);
    expect(scores.find((s) => s.name === "methodology_adherence")?.value).toBe(0.7);
    expect(captured).toContain("Логін валідними даними");
  });

  it("empty cases → [] (no invocation)", async () => {
    let called = false;
    const fakeInvoke: StructuredInvoke = async (schema) => {
      called = true;
      return schema.parse({ test_case_quality: 0, methodology_adherence: 0, comment: "" });
    };
    expect(await judgeTestCases([], "x", fakeInvoke, new PromptRegistry())).toEqual([]);
    expect(called).toBe(false);
  });

  it("judgeChecklistCoverage: semantic coverage + uncovered; empty checklist → 0 without invocation", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({ coverage: 0.75, uncovered: ["TC-05"] });
    const r = await judgeChecklistCoverage(
      [{ text: "TC-01" }, { text: "TC-05" }],
      [tc],
      fake,
      new PromptRegistry(),
    );
    expect(r.value).toBe(0.75);
    expect(r.comment).toContain("TC-05");

    let called = false;
    const fake2: StructuredInvoke = async (s) => {
      called = true;
      return s.parse({ coverage: 0, uncovered: [] });
    };
    expect((await judgeChecklistCoverage([], [], fake2, new PromptRegistry())).value).toBe(0);
    expect(called).toBe(false);
  });
});

describe("checklistCoverageScore (ADR-0022: decider first when asked, the LLM judge as fallback)", () => {
  const items = [{ text: "Sign In" }];
  const judged = { value: 0.5, comment: "uncovered: Sign In" };
  const fakeDecider = (answer: Answer | Error, shadow = false) => {
    const entries: ShadowEntry[] = [];
    let calls = 0;
    const decider: Decider = {
      provider: "laya",
      model: "jev-latest",
      caps: { maxInputChars: 1200, maxQuestionChars: 400, maxOptions: 20, maxQuestionsPerCall: 16 },
      uses: new Set(["coverage"]),
      minConfidence: 0.75,
      ...(shadow ? { shadow: { entries, record: (e: ShadowEntry) => void entries.push(e) } } : {}),
      summary: () => ({ provider: "laya", model: "jev-latest", calls, fallbacks: [] }),
      async decide(_use, _state, questions) {
        calls += 1;
        if (answer instanceof Error) throw answer;
        return Object.fromEntries(Object.keys(questions).map((k) => [k, answer])) as never;
      },
    };
    return { decider, entries, calls: () => calls };
  };
  const yes: Answer = { type: "noul", value: true, p: 0.95, confidence: 0.9 };

  it("without a decider: the judge's score, exactly today's object", async () => {
    const judge = vi.fn(async () => judged);
    const s = await checklistCoverageScore(items, [tc], judge);
    expect(s).toStrictEqual({ name: "checklist_coverage", value: 0.5, comment: "uncovered: Sign In" });
    expect(Object.keys(s)).toEqual(["name", "value", "comment"]);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("without a decider, a failing judge → the token score with no comment key, exactly as today", async () => {
    const s = await checklistCoverageScore(items, [tc], async () => Promise.reject(new Error("429")));
    expect(s).toStrictEqual({ name: "checklist_coverage", value: coverageScore(items, [tc]) });
  });

  it("an active decider that decides replaces the judge call", async () => {
    const judge = vi.fn(async () => judged);
    const s = await checklistCoverageScore(items, [tc], judge, fakeDecider(yes).decider);
    expect(s).toStrictEqual({ name: "checklist_coverage", value: 1, comment: "full coverage" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("an active decider that cannot decide hands over to the judge", async () => {
    const judge = vi.fn(async () => judged);
    const s = await checklistCoverageScore(items, [tc], judge, fakeDecider(new DeciderUnavailable("HTTP 500", 500)).decider);
    expect(s).toStrictEqual({ name: "checklist_coverage", value: 0.5, comment: "uncovered: Sign In" });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("an unexpected throw on the decider path is 'undecided' — the judge decides, the run goes on", async () => {
    const judge = vi.fn(async () => judged);
    const broken = [null] as unknown as { text: string }[]; // building the question throws a TypeError
    for (const shadow of [false, true]) {
      const s = await checklistCoverageScore(broken, [tc], judge, fakeDecider(yes, shadow).decider);
      expect(s).toStrictEqual({ name: "checklist_coverage", value: 0.5, comment: "uncovered: Sign In" });
    }
  });

  it("shadow: the judge's score is returned untouched; the decider's verdict and agreement are recorded", async () => {
    const judge = vi.fn(async () => judged);
    const f = fakeDecider(yes, true);
    const s = await checklistCoverageScore(items, [tc], judge, f.decider);
    expect(s).toStrictEqual({ name: "checklist_coverage", value: 0.5, comment: "uncovered: Sign In" });
    expect(f.entries).toEqual([
      expect.objectContaining({
        use: "coverage",
        input: { items: 1, cases: 1 },
        current: 0.5,
        decider: [{ item: "Sign In", covered: true }],
        agreement: 0, // |1 − 0.5| > 0.1
      }),
    ]);
  });

  it("shadow: agreement is 1 within 0.1, and absent when the decider could not decide", async () => {
    const agree = fakeDecider(yes, true);
    await checklistCoverageScore(items, [tc], async () => ({ value: 0.95, comment: "full coverage" }), agree.decider);
    expect(agree.entries[0]!.agreement).toBe(1);

    const dead = fakeDecider(new DeciderUnavailable("timeout after 10 ms"), true);
    await checklistCoverageScore(items, [tc], async () => judged, dead.decider);
    expect(dead.entries[0]).toMatchObject({ decider: { undecided: "unavailable: timeout after 10 ms" } });
    expect("agreement" in dead.entries[0]!).toBe(false);
  });
});
