export { OPENROUTER_BASE_URL, resolveModelSpec, makeModel } from "./factory.js";
export type { ModelSpec, ProviderKeys } from "./factory.js";
export { imageBlock } from "./vision.js";
export type { ImageBlock } from "./vision.js";
// L1-01 — per-role routing + cost/token accounting (ADR-0011).
export { structuredInvoker, meteredInvoker, retryInvoke, CallBudget, cappedInvoke } from "./structured.js";
export type { StructuredInvoke } from "./structured.js";
export { RoleRouter, resolveRoleTier, KNOWN_ROLES } from "./routing.js";
export { CostLedger, DEFAULT_PRICING, priceFor, extractUsage } from "./cost.js";
export type { CostReport, RoleCost, TokenUsage, ModelPrice } from "./cost.js";
