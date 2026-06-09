import { z } from "zod";

/** LLM provider (ADR-0002). */
export const ProviderSchema = z.enum(["anthropic", "openrouter"]);
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
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  langfuse: LangfuseConfig;
  browser: { backend: BrowserBackend; channel?: string };
  maxRepair: number;
  /** Language of generated test cases (env QA_TESTCASE_LANG; default "English"). */
  testCaseLanguage: string;
}
