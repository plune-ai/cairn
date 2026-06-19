import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { PageStudy } from "../observe/index.js";
import type { VerifiedElement } from "../browser/types.js";
import { formatTransitions, type Transition } from "../probe/index.js";
import { DesignResultSchema, type TestCase } from "./schema.js";
import { dedupCases } from "./dedup.js";

export type { TestCase, DesignedCase } from "./schema.js";
export {
  DesignedCaseSchema,
  DesignResultSchema,
  TestTechniqueSchema,
  TestPrioritySchema,
} from "./schema.js";

export interface DesignInput {
  study: PageStudy;
  pageSemantics: string;
  /** Checklist text (Sprint 4); currently empty. */
  checklistText?: string;
  /** Discovered elements (count≥1) from verify; fallback — study.elements. */
  elements?: VerifiedElement[];
  /** Observed state transitions (act→observe, Stage B). */
  transitions?: Transition[];
  /** Domain knowledge (credentials, validation rules) — URL-matched knowledge files. */
  knowledge?: string;
  /** Few-shot from experience: previously stable cases (experience-tracker). */
  experience?: string;
  /** Planning style for the run (happy/negative/coverage). */
  style?: string;
  /** Case language (default "English"). */
  language?: string;
}

export interface DesignDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
}

/**
 * Generate test cases from the page using the ISO 29119-4 methodology.
 * Grounding: elementRefs are filtered down to those actually present in study (anti-hallucination).
 */
export async function designTestCases(input: DesignInput, deps: DesignDeps): Promise<TestCase[]> {
  const methodology = (await deps.prompts.getPrompt("qa-manual-test-designer")).text;
  const els: VerifiedElement[] =
    input.elements ?? input.study.elements.map((e) => ({ ...e, count: 1, verified: true }));
  const elements = els
    .filter((e) => e.interactive)
    .map(
      (e) =>
        `${e.ref} · ${e.role}${e.name ? ` "${e.name}"` : ""}${e.count > 1 ? ` (×${e.count} — repeated, .first())` : ""}${e.viaSwitcher ? ` [behind tab "${e.viaSwitcher.name ?? ""}"]` : ""}`,
    )
    .join("\n");

  const prompt = await deps.prompts.getPrompt("qa-testcase-from-ui", {
    pageSemantics: input.pageSemantics,
    elements,
    methodology,
    checklist: input.checklistText ?? "",
    transitions: formatTransitions(input.transitions ?? []),
    language: input.language ?? "English",
    knowledge: input.knowledge ?? "",
    experience: input.experience ?? "",
    style: input.style ?? "",
  });

  const result = await deps.invoke(DesignResultSchema, [new HumanMessage(prompt.text)]);

  const known = new Set(els.map((e) => e.ref));
  const grounded = result.testCases.map((c, i) => ({
    ...c,
    id: `tc-${i + 1}`,
    elementRefs: c.elementRefs.filter((r) => known.has(r)),
  }));
  return dedupCases(grounded).merged; // #58: merge high-confidence near-duplicates (reduced count is the report)
}
