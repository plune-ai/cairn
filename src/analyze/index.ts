import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { PageStudy } from "../observe/index.js";
import { imageBlock } from "../llm/index.js";

export const PageAnalysisSchema = z.object({
  pageSemantics: z.string(),
  primaryRefs: z.array(z.string()).default([]),
  /** Refs of view/tab/wizard-step switchers (a click opens different content). */
  viewSwitchers: z.array(z.string()).default([]),
});
export type PageAnalysis = z.infer<typeof PageAnalysisSchema>;

export interface AnalyzeDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
  /** Send the screenshot (vision). If false or the model has no vision — aria-only mode (ADR-0002). */
  vision?: boolean;
}

/**
 * Page analysis (identifyElements node): page purpose + the most important refs.
 * Grounding: primaryRefs are filtered to those actually present (anti-hallucination).
 */
export async function analyzePage(study: PageStudy, deps: AnalyzeDeps): Promise<PageAnalysis> {
  const elements = study.elements
    .map((e) => `${e.ref} · ${e.role}${e.name ? ` "${e.name}"` : ""}`)
    .join("\n");
  const prompt = await deps.prompts.getPrompt("identify-elements", {
    ariaYaml: study.ariaYaml,
    elements,
  });

  const useVision = Boolean(deps.vision && study.screenshotB64);
  const message = useVision
    ? new HumanMessage({
        content: [
          { type: "text", text: prompt.text },
          imageBlock(study.screenshotB64, "image/png"),
        ],
      })
    : new HumanMessage(prompt.text);

  const raw = await deps.invoke(PageAnalysisSchema, [message]);
  const known = new Set(study.elements.map((e) => e.ref));
  return {
    pageSemantics: raw.pageSemantics,
    primaryRefs: raw.primaryRefs.filter((r) => known.has(r)),
    viewSwitchers: raw.viewSwitchers.filter((r) => known.has(r)),
  };
}
