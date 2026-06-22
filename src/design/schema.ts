import { z } from "zod";

/** ISO/IEC/IEEE 29119-4 techniques. */
export const TestTechniqueSchema = z.enum([
  "equivalence-partitioning",
  "boundary-value",
  "decision-table",
  "state-transition",
  "exploratory",
  "error-guessing",
]);

export const TestPrioritySchema = z.enum(["low", "medium", "high", "critical"]);

/** Case kind: static = read-only check (visibility/state); active = with actions (click/fill/navigation). */
export const TestKindSchema = z.enum(["static", "active"]);

/** Scenario nature: Positive (valid path) | Negative (invalid/erroneous). */
export const TestTypeSchema = z.enum(["Positive", "Negative"]);

/**
 * Execution: auto = the bot can reliably automate (read-only, verified locators) → ATC;
 * manual = manual (full generation/submit, security/XSS, UI-UX/visual, irreversible actions) → MTC, NOT automated.
 */
export const TestExecutionSchema = z.enum(["auto", "manual"]);

/** A case as returned by the LLM (without id — we assign the id ourselves). */
export const DesignedCaseSchema = z.object({
  title: z.string(),
  technique: TestTechniqueSchema,
  kind: TestKindSchema.default("static"),
  type: TestTypeSchema.default("Positive"),
  execution: TestExecutionSchema.default("auto"),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(z.string()),
  expected: z.string(),
  priority: TestPrioritySchema,
  elementRefs: z.array(z.string()).default([]),
});
export type DesignedCase = z.infer<typeof DesignedCaseSchema>;

export const DesignResultSchema = z.object({ testCases: z.array(DesignedCaseSchema) });

/** Final test case with an assigned id. */
export interface TestCase extends DesignedCase {
  id: string;
}

/**
 * One step of a multi-page journey (#59): which page it runs on, the action, and the element refs it
 * touches. Refs are grounded PER PAGE (a step only references elements that exist on its own page).
 */
export const JourneyStepSchema = z.object({
  /** URL of the page this step runs on (must be one of the graph's node URLs). */
  page: z.string(),
  /** Human-readable step (real element labels). */
  action: z.string(),
  elementRefs: z.array(z.string()).default([]),
});
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

/** A user journey that spans ≥2 pages — an ordered list of cross-page steps (#59). */
export const DesignedJourneySchema = z.object({
  title: z.string(),
  technique: TestTechniqueSchema,
  type: TestTypeSchema.default("Positive"),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(JourneyStepSchema),
  expected: z.string(),
  priority: TestPrioritySchema,
});
export type DesignedJourney = z.infer<typeof DesignedJourneySchema>;

export const JourneyResultSchema = z.object({ journeys: z.array(DesignedJourneySchema) });

/** Final journey case with an assigned id. */
export interface JourneyCase extends DesignedJourney {
  id: string;
}
