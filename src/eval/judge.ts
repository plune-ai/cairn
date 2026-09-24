import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { TestCase } from "../design/index.js";
import { coverageScore, type ChecklistItem } from "../checklist/index.js";
import type { Decider } from "../decider/types.js";
import { deciderChecklistCoverage, type DeciderCoverage } from "../decider/uses/coverage.js";
import type { Score } from "./scorers.js";

export const JudgeSchema = z.object({
  test_case_quality: z.number().min(0).max(1),
  methodology_adherence: z.number().min(0).max(1),
  comment: z.string(),
});

/**
 * LLM-as-judge (SDK-side, cheap tier) — subjective evaluation of cases (ADR-0006).
 * The prompt is versioned in the registry ("judge-test-cases"), like the methodology prompts.
 */
export async function judgeTestCases(
  testCases: TestCase[],
  pageSemantics: string,
  invoke: StructuredInvoke,
  prompts: PromptRegistry,
): Promise<Score[]> {
  if (testCases.length === 0) return [];
  const cases = testCases
    .map((tc) => `- [${tc.technique}] ${tc.title}: ${tc.steps.join("; ")} ⇒ ${tc.expected}`)
    .join("\n");
  const prompt = await prompts.getPrompt("judge-test-cases", { pageSemantics, cases });
  const r = await invoke(JudgeSchema, [new HumanMessage(prompt.text)]);
  return [
    { name: "test_case_quality", value: r.test_case_quality, comment: r.comment },
    { name: "methodology_adherence", value: r.methodology_adherence },
  ];
}

export const ChecklistCoverageSchema = z.object({
  coverage: z.number().min(0).max(1),
  uncovered: z.array(z.string()).default([]),
});

/**
 * Semantic coverage of the checklist by the cases (LLM judge) — understands meaning regardless of LANGUAGE.
 * The prompt is versioned in the registry ("judge-checklist-coverage").
 */
export async function judgeChecklistCoverage(
  checklistItems: { text: string }[],
  testCases: TestCase[],
  invoke: StructuredInvoke,
  prompts: PromptRegistry,
): Promise<{ value: number; comment: string }> {
  if (checklistItems.length === 0) return { value: 0, comment: "" };
  const items = checklistItems.map((i, n) => `${n + 1}. ${i.text}`).join("\n");
  const cases = testCases
    .map((tc) => `- ${tc.title}: ${tc.steps.join("; ")} ⇒ ${tc.expected}`)
    .join("\n");
  const prompt = await prompts.getPrompt("judge-checklist-coverage", { items, cases });
  const r = await invoke(ChecklistCoverageSchema, [new HumanMessage(prompt.text)]);
  return {
    value: r.coverage,
    comment: r.uncovered.length > 0 ? `uncovered: ${r.uncovered.join("; ")}` : "full coverage",
  };
}

/**
 * The `checklist_coverage` score (ADR-0022). A decider that decides replaces the LLM judge; otherwise the judge
 * runs, and if it fails, the token overlap — the very objects a run without a decider produces, so its
 * `report.json` stays byte-identical. In shadow mode the judge's score is returned untouched and the decider's
 * verdict is recorded next to it.
 */
export async function checklistCoverageScore(
  items: ChecklistItem[],
  cases: TestCase[],
  judge: () => Promise<{ value: number; comment: string }>,
  decider?: Decider,
): Promise<Score> {
  // The decider never sinks a run (ADR-0022): even an unexpected throw is just "undecided".
  const ask = (d: Decider): Promise<DeciderCoverage> =>
    deciderChecklistCoverage(items, cases, d).catch((e: unknown) => ({
      undecided: `error: ${e instanceof Error ? e.message : String(e)}`,
      asked: [],
    }));
  if (decider && !decider.shadow) {
    const d = await ask(decider);
    // A metric, not a gate: the decider's number replaces the judge's — and says so in the report.
    if (!("undecided" in d)) return { name: "checklist_coverage", value: d.value, comment: `decider (${decider.provider}): ${d.comment}` };
  }
  let current: Score;
  let source: "judge" | "token-overlap" = "judge";
  try {
    const cov = await judge();
    current = { name: "checklist_coverage", value: cov.value, comment: cov.comment };
  } catch {
    // fallback: token-based coverage (offline / judge unavailable)
    source = "token-overlap";
    current = { name: "checklist_coverage", value: coverageScore(items, cases) };
  }
  if (decider?.shadow) {
    try {
      const t0 = Date.now();
      const d = await ask(decider);
      decider.shadow.record({
        use: "coverage",
        input: { items: items.map((i) => i.text), cases: cases.map((c) => c.title) },
        current: { value: current.value, source },
        decider: d,
        latencyMs: Date.now() - t0,
        // Only against the judge: the token overlap is a fallback, not the judgment the decider would replace.
        ...("undecided" in d || source !== "judge" ? {} : { agreement: Math.abs(d.value - current.value) <= 0.1 + 1e-9 ? 1 : 0 }),
      });
    } catch {
      // shadow bookkeeping never touches the run
    }
  }
  return current;
}
