import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import { DesignResultSchema, type TestCase } from "../design/schema.js";
import type { CoverageGap } from "./coverage.js";

export interface GapCaseInput {
  /** Top untested elements to suggest cases for. */
  gaps: CoverageGap[];
  pageSemantics?: string;
  language?: string;
}

export interface GapCaseDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
}

/**
 * #61 — suggest test cases for the top untested surface (worker tier). Returned cases are clearly
 * marked as SUGGESTIONS via a `gap-` id prefix and grounded to the gap refs (anti-hallucination).
 * Returns [] without calling the LLM when there are no gaps.
 */
export async function designGapCases(input: GapCaseInput, deps: GapCaseDeps): Promise<TestCase[]> {
  if (input.gaps.length === 0) return [];
  const known = new Set(input.gaps.map((g) => g.ref));
  const gapList = input.gaps
    .map((g) => `- ${g.ref} · ${g.role}${g.name ? ` "${g.name}"` : ""} (${g.page}) — ${g.why}`)
    .join("\n");

  const prompt = await deps.prompts.getPrompt("qa-gap-cases", {
    gaps: gapList,
    pageSemantics: input.pageSemantics ?? "",
    language: input.language ?? "English",
  });
  const result = await deps.invoke(DesignResultSchema, [new HumanMessage(prompt.text)]);

  return result.testCases.map((c, i) => ({
    ...c,
    id: `gap-${i + 1}`,
    elementRefs: c.elementRefs.filter((r) => known.has(r)),
  }));
}
