import { describe, it, expect } from "vitest";
import { caseState, deciderChecklistCoverage } from "../../src/decider/uses/coverage.js";
import { DeciderUnavailable, type Answer, type Decider, type Question, type ShadowEntry } from "../../src/decider/types.js";
import type { TestCase } from "../../src/design/index.js";

const tc = (title: string, over: Partial<TestCase> = {}): TestCase => ({
  id: title,
  title,
  technique: "equivalence-partitioning",
  preconditions: [],
  steps: [`open ${title}`, "press Save"],
  expected: `${title} is saved`,
  priority: "high",
  elementRefs: [],
  ...over,
});

type Script = (state: string, instructions: string) => Answer | Error;
/** Answers each noul by (case state, item question); captures every call. */
function fakeDecider(script: Script, over: { maxQuestionsPerCall?: number; shadow?: boolean } = {}) {
  const calls: { state: string; questions: Record<string, Question> }[] = [];
  const entries: ShadowEntry[] = [];
  const decider: Decider = {
    provider: "laya",
    model: "jev-latest",
    caps: { maxStateChars: 1200, maxOptions: 20, maxQuestionsPerCall: over.maxQuestionsPerCall ?? 16 },
    uses: new Set(["coverage"]),
    minConfidence: 0.75,
    ...(over.shadow ? { shadow: { entries, record: (e: ShadowEntry) => void entries.push(e) } } : {}),
    summary: () => ({ provider: "laya", model: "jev-latest", calls: calls.length, fallbacks: [] }),
    async decide(_use, state, questions) {
      calls.push({ state, questions: questions as Record<string, Question> });
      const out: Record<string, Answer> = {};
      for (const [k, q] of Object.entries(questions as Record<string, Question>)) {
        const a = script(state, q.instructions);
        if (a instanceof Error) throw a;
        out[k] = a;
      }
      return out as never;
    },
  };
  return { decider, calls, entries };
}
const yes = (confidence = 0.9): Answer => ({ type: "noul", value: true, p: (1 + confidence) / 2, confidence });
const no = (confidence = 0.9): Answer => ({ type: "noul", value: false, p: (1 - confidence) / 2, confidence });
const items = [{ text: "login works" }, { text: "logout works" }];

describe("coverage by decider (spec §6.2)", () => {
  it("one call per case, one noul per checklist item — the item in the question, the case as the state", async () => {
    const { decider, calls } = fakeDecider(() => no());
    await deciderChecklistCoverage(items, [tc("Login")], decider);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toBe(caseState(tc("Login")));
    const qs = Object.values(calls[0]!.questions);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } });
    expect(qs[0]!.instructions).toContain("login works");
    expect(qs[1]!.instructions).toContain("logout works");
  });

  it("an item is covered when some case confidently says yes", async () => {
    const { decider } = fakeDecider((s, q) => (s.includes("Login") === q.includes("login works") ? yes() : no()));
    const r = await deciderChecklistCoverage(items, [tc("Login"), tc("Logout")], decider);
    expect(r).toEqual({
      value: 1,
      comment: "full coverage",
      perItem: [
        { item: "login works", covered: true },
        { item: "logout works", covered: true },
      ],
    });
  });

  it("confident no everywhere → uncovered, in the judge's comment format", async () => {
    const { decider } = fakeDecider(() => no());
    expect(await deciderChecklistCoverage(items, [tc("Profile")], decider)).toMatchObject({
      value: 0,
      comment: "uncovered: login works; logout works",
    });
  });

  it("an item with no confident yes and an unsure answer → undecided (the LLM judge decides)", async () => {
    const { decider } = fakeDecider((_s, q) => (q.includes("logout") ? no(0.3) : yes()));
    expect(await deciderChecklistCoverage(items, [tc("Login")], decider)).toEqual({ undecided: "unsure about: logout works" });
  });

  it("an unsure answer does not matter once another case covers the item confidently", async () => {
    const { decider } = fakeDecider((s, q) => (q.includes("logout") ? (s.includes("Logout") ? yes() : no(0.3)) : yes()));
    expect(await deciderChecklistCoverage(items, [tc("Login"), tc("Logout")], decider)).toMatchObject({ value: 1 });
  });

  it("an unavailable decider → undecided, and no further case is asked", async () => {
    const { decider, calls } = fakeDecider(() => new DeciderUnavailable("state is 5000 chars > 1200"));
    expect(await deciderChecklistCoverage(items, [tc("A"), tc("B"), tc("C")], decider)).toEqual({
      undecided: "unavailable: state is 5000 chars > 1200",
    });
    expect(calls).toHaveLength(1);
  });

  it("an item already covered is not asked about again", async () => {
    const { decider, calls } = fakeDecider((_s, q) => (q.includes("login works") ? yes() : no()));
    await deciderChecklistCoverage(items, [tc("A"), tc("B")], decider);
    expect(Object.keys(calls[1]!.questions)).toHaveLength(1); // only "logout works" is still open
  });

  it("items are chunked by the provider's questions-per-call cap", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ text: `item ${i}` }));
    const { decider, calls } = fakeDecider(() => no(), { maxQuestionsPerCall: 2 });
    await deciderChecklistCoverage(many, [tc("A")], decider);
    expect(calls.map((c) => Object.keys(c.questions).length)).toEqual([2, 2, 1]);
  });

  it("the case state is not clipped — an over-long case is the provider's caps to refuse (a fallback)", () => {
    const long = tc("L", { steps: ["x".repeat(3000)] });
    expect(caseState(long)).toContain("x".repeat(3000));
    expect(caseState(tc("Login", { preconditions: ["a user exists"] }))).toBe(
      "Test case: Login\nPreconditions: a user exists\nSteps:\n1. open Login\n2. press Save\nExpected result: Login is saved",
    );
  });

  it("an answer of the wrong type is not trusted", async () => {
    const { decider } = fakeDecider(() => ({ type: "choice", value: "a", dist: { a: 1 }, confidence: 1 }));
    expect(await deciderChecklistCoverage(items, [tc("A")], decider)).toEqual({ undecided: "an answer that is not a yes/no" });
  });

  it("no cases → nothing is covered, and no call is made", async () => {
    const { decider, calls } = fakeDecider(() => yes());
    expect(await deciderChecklistCoverage(items, [], decider)).toMatchObject({ value: 0 });
    expect(calls).toHaveLength(0);
  });
});
