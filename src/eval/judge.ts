import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { TestCase } from "../design/index.js";
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
