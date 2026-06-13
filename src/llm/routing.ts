import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig, ModelTier, RolesConfig } from "../config/index.js";
import { makeModel, structuredMethodFor, type ProviderKeys } from "./factory.js";
import { meteredInvoker, cappedInvoke, retryInvoke } from "./structured.js";
import type { CallBudget, StructuredInvoke } from "./structured.js";
import { CostLedger, type ModelPrice } from "./cost.js";

/**
 * Routable roles (L1-01, ADR-0011). The cheap LLM-as-judge scorer keeps the `judge`
 * tier and is metered-only — NOT routable (it has the opposite cost intent).
 */
export const KNOWN_ROLES = ["worker", "reasoner"] as const;

/** Pure: which tier does this role use? An explicit override (`roles[role]`) wins, else the fallback. */
export function resolveRoleTier(
  role: string,
  fallback: ModelTier,
  roles: RolesConfig | undefined,
): ModelTier {
  return (roles?.[role as (typeof KNOWN_ROLES)[number]] as ModelTier | undefined) ?? fallback;
}

type ModelFactory = (tier: ModelTier, keys: ProviderKeys) => BaseChatModel;

/**
 * Builds per-step metered invokers over `makeModel(tier)` and owns the per-role
 * {@link CostLedger}. One per run, a sibling of `CallBudget`. The model factory is
 * injectable so the router is unit-testable without the SDK.
 */
export class RoleRouter {
  readonly ledger: CostLedger;

  constructor(
    private readonly cfg: AppConfig,
    private readonly keys: ProviderKeys,
    private readonly budget: CallBudget,
    pricing?: Record<string, ModelPrice>,
    private readonly makeModelFn: ModelFactory = makeModel,
  ) {
    this.ledger = new CostLedger(pricing);
  }

  /** Resolved tier for a role: the routing override if present, else the given fallback tier. */
  tierFor(role: string, fallback: ModelTier): ModelTier {
    return resolveRoleTier(role, fallback, this.cfg.roles);
  }

  /**
   * A `StructuredInvoke` for an already-resolved tier, metered under `role` and wrapped
   * with the existing retry + call-budget guardrails. Drop-in for the old
   * `cappedInvoke(retryInvoke(structuredInvoker(makeModel(tier, keys))), budget)`.
   */
  invoke(role: string, tier: ModelTier): StructuredInvoke {
    const model = this.makeModelFn(tier, this.keys);
    // Groq needs functionCalling (its OpenAI-compat endpoint rejects json_schema) — L1-02 fix.
    const method = structuredMethodFor(tier.provider);
    const metered = meteredInvoker(model, (u, m) => this.ledger.record(role, m, u), tier.model, method);
    return cappedInvoke(retryInvoke(metered), this.budget);
  }
}
