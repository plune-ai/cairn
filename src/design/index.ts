import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { PageStudy } from "../observe/index.js";
import type { VerifiedElement } from "../browser/types.js";
import { formatTransitions, type Transition } from "../probe/index.js";
import { DesignResultSchema, type TestCase } from "./schema.js";
import { dedupCases } from "./dedup.js";
import { designedCaseStableId } from "../artifacts/contract.js";

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
  /** #63: pre-formatted goal directive ({@link formatGoal}) — leads with goal-relevant cases. "" → no bias. */
  goalText?: string;
  /** Discovered elements (count≥1) from verify; fallback — study.elements. */
  elements?: VerifiedElement[];
  /** Observed state transitions (act→observe, Stage B). */
  transitions?: Transition[];
  /** #225: the overlays found by exploration ({@link formatOverlays}); "" → none. */
  overlays?: string;
  /** Domain knowledge (credentials, validation rules) — URL-matched knowledge files. */
  knowledge?: string;
  /** Few-shot from experience: previously stable cases (experience-tracker). */
  experience?: string;
  /** Planning style for the run (happy/negative/coverage). */
  style?: string;
  /** Case language (default "English"). */
  language?: string;
}

/** #225: heads the overlay block of the design prompt; the cases it asks for are the state-transition set for an overlay. */
export const OVERLAY_HEADER = `Overlays found on the page (dialogs, drawers, menus, wizards) — each is a STATE with a trigger and exits. For EACH overlay apply the state-transition technique and write these cases (technique "state-transition"), each one a separate case:
- open: the trigger opens it (check its name / heading is visible);
- cancel: it closes with its Cancel / close button and the page is as before;
- Esc: it closes on Escape — only when the exits below do not say "does not close it";
- save valid: the submit with valid data completes it and closes it (execution "manual" when the submit is marked destructive);
- save invalid: the submit with empty or invalid data keeps it open and shows the validation message;
- nested confirmation: an overlay opened from another one (parent) is confirmed or cancelled, and the parent is still there after cancel;
- wizard: Next moves one step on, Back returns, Next is blocked when the step's validation says so.
Only write the cases an overlay's exits and elements make possible. Name the overlay's elements by their labels in the steps; never click anything that lies under an open modal overlay.`;

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
        `${e.ref} · ${e.role}${e.name ? ` "${e.name}"` : ""}${e.count > 1 ? ` (×${e.count} — repeated, .first())` : ""}${e.scope ? ` [inside ${e.scope.role}${e.scope.name ? ` "${e.scope.name}"` : ""}]` : ""}${e.viaSwitcher ? ` [behind tab "${e.viaSwitcher.name ?? ""}"]` : ""}`,
    )
    .join("\n");

  const prompt = await deps.prompts.getPrompt("qa-testcase-from-ui", {
    pageSemantics: input.pageSemantics,
    elements,
    methodology,
    goal: input.goalText ?? "",
    checklist: input.checklistText ?? "",
    transitions: formatTransitions(input.transitions ?? []),
    overlays: input.overlays ? `${OVERLAY_HEADER}\n${input.overlays}` : "",
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
    // Substance, not position: the same case keeps this id across runs even when the run designs a
    // different number of cases and `id` shifts under it.
    stableId: designedCaseStableId(c),
    elementRefs: c.elementRefs.filter((r) => known.has(r)),
  }));
  return dedupCases(grounded).merged; // #58: merge high-confidence near-duplicates (reduced count is the report)
}
