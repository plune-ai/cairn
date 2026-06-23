import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { JourneyCase } from "../design/schema.js";
import { isDeletionIntent } from "../safety/guardrails.js";

/**
 * How a precondition's starting state is established, in priority order:
 *  - session   — already covered by the captured storageState (auth);
 *  - fixture   — a Playwright `beforeEach` that drives the UI to the starting state;
 *  - api-seed  — a request seed against an OBSERVED endpoint (only with a concrete endpoint);
 *  - manual    — documented, human-established precondition (the safe fallback — never fabricated).
 */
export const SetupStrategySchema = z.enum(["session", "fixture", "api-seed", "manual"]);
export type SetupStrategy = z.infer<typeof SetupStrategySchema>;

/** A structured starting-state requirement (#60) — replaces free prose where it can be made concrete. */
export const StructuredPreconditionSchema = z.object({
  /** Human-readable precondition (always present — also the manual-fallback text). */
  description: z.string(),
  strategy: SetupStrategySchema,
  /**
   * Grounded entity the state is about, e.g. "item", "user on plan Pro" (null when not applicable).
   * `.nullable().default(null)` keeps the key in `required` (provider-safe, #89) while tolerating a
   * provider that omits it — instead of `.optional()`, which drops it from `required`.
   */
  entity: z.string().nullable().default(null),
  /** api-seed only: the endpoint to seed against — null unless the strategy is api-seed. */
  endpoint: z.string().nullable().default(null),
  /** api-seed only: HTTP method (null ⇒ POST when seeding). */
  method: z.enum(["GET", "POST", "PUT", "PATCH"]).nullable().default(null),
});
export type StructuredPrecondition = z.infer<typeof StructuredPreconditionSchema>;

export const SetupPlanSchema = z.object({ preconditions: z.array(StructuredPreconditionSchema) });
export type SetupPlan = z.infer<typeof SetupPlanSchema>;

export interface SetupInput {
  journey: JourneyCase;
  /** Page purpose (optional context for the planner). */
  pageSemantics?: string;
}

export interface SetupDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
}

/**
 * Safety post-process: a precondition can only be satisfied by `api-seed` when a CONCRETE endpoint is
 * named — otherwise we'd be fabricating (possibly destructive) seeding, which is forbidden. Such a
 * precondition is downgraded to the documented `manual` fallback. Pure — unit-testable.
 */
export function enforceSafeStrategies(plan: SetupPlan): SetupPlan {
  return {
    preconditions: plan.preconditions.map((p) =>
      p.strategy === "api-seed" && !p.endpoint ? { ...p, strategy: "manual" as const } : p,
    ),
  };
}

/**
 * Data-protection guardrail (#91): a precondition that establishes its state by DELETING / clearing data
 * is forced to the `manual` fallback — at setup time nothing is self-created yet, so any such deletion
 * would hit pre-existing data, which is forbidden. The deletion is never auto-seeded; a human decides.
 */
export function enforceDataProtection(plan: SetupPlan): SetupPlan {
  return {
    preconditions: plan.preconditions.map((p) =>
      p.strategy !== "manual" && isDeletionIntent(p.description) ? { ...p, strategy: "manual" as const } : p,
    ),
  };
}

/**
 * #60 — extract STRUCTURED preconditions from a journey's prose preconditions, on the worker tier.
 * The planner assigns each one a satisfaction strategy (session > fixture > api-seed > manual);
 * unsafe/unfounded seeding is forced to manual by {@link enforceSafeStrategies}.
 */
export async function planSetup(input: SetupInput, deps: SetupDeps): Promise<SetupPlan> {
  const { journey } = input;
  const prompt = await deps.prompts.getPrompt("qa-setup-planner", {
    title: journey.title,
    preconditions: journey.preconditions.map((p) => `- ${p}`).join("\n") || "(none stated)",
    pages: [...new Set(journey.steps.map((s) => s.page))].join(", "),
    pageSemantics: input.pageSemantics ?? "",
  });
  const result = await deps.invoke(SetupPlanSchema, [new HumanMessage(prompt.text)]);
  return enforceDataProtection(enforceSafeStrategies(result));
}
