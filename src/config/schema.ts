import { z } from "zod";

/** LLM provider (ADR-0002; Groq added in L1-02). */
export const ProviderSchema = z.enum(["anthropic", "openrouter", "groq"]);
export type Provider = z.infer<typeof ProviderSchema>;

/** Model settings for a single tier. */
export const ModelTierSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  supportsVision: z.boolean().default(false),
  temperature: z.number().optional(),
});
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** Mapping tier → model (ADR-0002, see docs/architecture/data-contracts.md). */
export const ModelsConfigSchema = z.object({
  reasoning: ModelTierSchema, // designTestCases (+ identifyElements if vision)
  bulk: ModelTierSchema, // generateCode
  judge: ModelTierSchema, // LLM-as-judge (SDK-side)
  vision: ModelTierSchema.optional(), // if reasoning has no vision → aria-only fallback
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/**
 * Named role over the tier map (L1-01). Only these two are routable; the cheap
 * LLM-as-judge scorer keeps the `judge` tier and is NOT a role (see ADR-0011).
 */
export const RoleSchema = z.enum(["worker", "reasoner"]);
export type Role = z.infer<typeof RoleSchema>;

/** A role override reuses the tier shape (provider + model + vision + temperature). */
export type RoleModel = ModelTier;

/** Optional per-role routing overrides, layered over `models` (the tier map). */
export type RolesConfig = Partial<Record<Role, RoleModel>>;

export const LlmProfileSchema = z.enum(["anthropic", "openrouter", "mixed"]);
export type LlmProfile = z.infer<typeof LlmProfileSchema>;

export const BrowserBackendSchema = z.enum(["lib", "cli"]);
export type BrowserBackend = z.infer<typeof BrowserBackendSchema>;

export interface LangfuseConfig {
  enabled: boolean;
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
}

/** Full typed bot configuration. */
export interface AppConfig {
  llmProfile: LlmProfile;
  models: ModelsConfig;
  /** L1-01 per-role routing overrides (optional; layered over `models`). */
  roles?: RolesConfig;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  groqApiKey?: string;
  langfuse: LangfuseConfig;
  browser: { backend: BrowserBackend; channel?: string };
  maxRepair: number;
  /** Playwright worker count for running the generated tests (env PLAYWRIGHT_WORKERS; default 5). */
  playwrightWorkers: number;
  /** Language of generated test cases (env QA_TESTCASE_LANG; default "English"). */
  testCaseLanguage: string;
}
