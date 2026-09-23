import type { TestCase } from "../../design/index.js";
import type { Decider, Question } from "../types.js";

/**
 * coverage (spec §6.2, ADR-0022): the checklist × case matrix as yes/no judgments. An item is covered when
 * some case confidently says yes. Anything short of a confident verdict on every item is `undecided`, and
 * the LLM judge decides exactly as it does without a decider.
 */
export type DeciderCoverage =
  | { value: number; comment: string; perItem: { item: string; covered: boolean }[] }
  | { undecided: string };

const CRITERIA = {
  true: "Its steps or expected result exercise this checklist item",
  false: "It does not exercise this checklist item",
};

/** The case as the decider sees it. Not clipped: an over-long case is refused by the caps — a fallback, not a guess. */
export function caseState(tc: TestCase): string {
  return [
    `Test case: ${tc.title}`,
    ...(tc.preconditions.length ? [`Preconditions: ${tc.preconditions.join("; ")}`] : []),
    "Steps:",
    ...tc.steps.map((s, i) => `${i + 1}. ${s}`),
    `Expected result: ${tc.expected}`,
  ].join("\n");
}

/**
 * One call per case, one `noul` per still-open item (chunked by the provider's questions-per-call cap).
 * Cases are asked one after another: a covered item is not asked again, the first unavailable call ends the
 * pass (so a hanging server costs one timeout), and a single-worker local server is never flooded.
 */
export async function deciderChecklistCoverage(
  items: { text: string }[],
  cases: TestCase[],
  decider: Decider,
): Promise<DeciderCoverage> {
  const covered = new Set<number>();
  const unsure = new Set<number>();
  for (const tc of cases) {
    const open = items.map((_, i) => i).filter((i) => !covered.has(i));
    for (let at = 0; at < open.length; at += decider.caps.maxQuestionsPerCall) {
      const chunk = open.slice(at, at + decider.caps.maxQuestionsPerCall);
      const questions: Record<string, Question> = Object.fromEntries(
        chunk.map((i) => [
          `i${i}`,
          { type: "noul", instructions: `Does this test case exercise the checklist item "${items[i]!.text}"?`, criteria: CRITERIA },
        ]),
      );
      let answers;
      try {
        answers = await decider.decide("coverage", caseState(tc), questions);
      } catch (e) {
        return { undecided: `unavailable: ${e instanceof Error ? e.message : String(e)}` };
      }
      for (const i of chunk) {
        const a = answers[`i${i}`];
        if (a?.type !== "noul") return { undecided: "an answer that is not a yes/no" };
        if (a.confidence < decider.minConfidence) unsure.add(i);
        else if (a.value) covered.add(i);
      }
    }
  }
  const doubtful = items.filter((_, i) => !covered.has(i) && unsure.has(i)).map((it) => it.text);
  if (doubtful.length > 0) return { undecided: `unsure about: ${doubtful.join("; ")}` };
  const uncovered = items.filter((_, i) => !covered.has(i)).map((it) => it.text);
  return {
    value: items.length ? covered.size / items.length : 0,
    comment: uncovered.length > 0 ? `uncovered: ${uncovered.join("; ")}` : "full coverage",
    perItem: items.map((it, i) => ({ item: it.text, covered: covered.has(i) })),
  };
}
