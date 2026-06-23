import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { TestCase } from "../design/index.js";
import type { ValidationReport } from "../validate/index.js";
import { checkProvenance } from "../safety/guardrails.js";

export const PilotSchema = z.object({
  verdict: z.enum(["pass", "needs-work", "fail"]),
  reason: z.string(),
  guidance: z.string(),
  /** Name of the entity this run created/edited (for the provenance check) — "" if read-only (#91). */
  entity: z.string(),
});
export type PilotVerdict = z.infer<typeof PilotSchema>;

/**
 * Pilot supervisor (idea from explorbot): a holistic run verdict (pass/needs-work/fail) + guidance.
 * Complements the per-metric judge with a single decision on "whether the run is good enough".
 */
export async function pilotReview(
  pageSemantics: string,
  validation: ValidationReport | undefined,
  testCases: TestCase[],
  invoke: StructuredInvoke,
  prompts: PromptRegistry,
  /** What the run actually touched (case titles/steps, observed element names) — for the #91 provenance check. */
  sessionLog: string[] = [],
): Promise<PilotVerdict> {
  const validationText = validation
    ? `${Math.round(validation.greenRatio * 100)}% green (${validation.results.length} tests, flaky: ${validation.flakyCount})`
    : "(no validation — case design only)";
  const cases = testCases.map((tc) => `- [${tc.type}/${tc.priority}] ${tc.title}`).join("\n");
  const prompt = await prompts.getPrompt("pilot-review", {
    pageSemantics,
    validation: validationText,
    cases,
  });
  const verdict = await invoke(PilotSchema, [new HumanMessage(prompt.text)]);
  // #91: a "pass" that names an entity is only trusted when that entity appears in the session log.
  return checkProvenance(verdict, sessionLog);
}
