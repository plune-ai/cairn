import {
  BrowserBackendSchema,
  LlmProfileSchema,
  ModelsConfigSchema,
} from "./schema.js";
import type { AppConfig, Provider } from "./schema.js";
import { PROFILES } from "./profiles.js";

export type { AppConfig, ModelsConfig, ModelTier, Provider, LlmProfile, BrowserBackend } from "./schema.js";

type Env = Record<string, string | undefined>;

/**
 * Read and validate configuration from env. Pure function (env is injected for tests).
 * Throws a clear error on an invalid profile/backend or a missing key for a required provider.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const profileResult = LlmProfileSchema.safeParse(env.LLM_PROFILE ?? "anthropic");
  if (!profileResult.success) {
    throw new Error(
      `Invalid LLM_PROFILE='${env.LLM_PROFILE}'. Allowed: anthropic | openrouter | mixed.`,
    );
  }
  const llmProfile = profileResult.data;
  const models = ModelsConfigSchema.parse(PROFILES[llmProfile]);

  // Which providers does this profile actually need?
  const tiers = [models.reasoning, models.bulk, models.judge];
  if (models.vision) tiers.push(models.vision);
  const providers = new Set<Provider>(tiers.map((t) => t.provider));

  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  const openrouterApiKey = env.OPENROUTER_API_KEY;
  if (providers.has("anthropic") && !anthropicApiKey) {
    throw new Error(
      `Profile '${llmProfile}' uses Anthropic, but ANTHROPIC_API_KEY is not set.`,
    );
  }
  if (providers.has("openrouter") && !openrouterApiKey) {
    throw new Error(
      `Profile '${llmProfile}' uses OpenRouter, but OPENROUTER_API_KEY is not set.`,
    );
  }

  const backendResult = BrowserBackendSchema.safeParse(env.BROWSER_BACKEND ?? "lib");
  if (!backendResult.success) {
    throw new Error(`Invalid BROWSER_BACKEND='${env.BROWSER_BACKEND}'. Allowed: lib | cli.`);
  }

  const langfuseEnabled = Boolean(
    env.LANGFUSE_BASE_URL && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY,
  );

  const maxRepair = env.MAX_REPAIR === undefined ? 2 : Number(env.MAX_REPAIR);
  if (!Number.isInteger(maxRepair) || maxRepair < 0) {
    throw new Error(`Invalid MAX_REPAIR='${env.MAX_REPAIR}'. Must be a non-negative integer.`);
  }

  // Test-case language: default English; env override accepts a name or a code (en/uk/ua).
  const langRaw = (env.QA_TESTCASE_LANG ?? "English").trim();
  const LANG_ALIASES: Record<string, string> = {
    en: "English",
    eng: "English",
    english: "English",
    uk: "Ukrainian",
    ua: "Ukrainian",
    ukr: "Ukrainian",
    ukrainian: "Ukrainian",
    українська: "Ukrainian",
  };
  const testCaseLanguage = LANG_ALIASES[langRaw.toLowerCase()] ?? langRaw;

  return {
    llmProfile,
    models,
    anthropicApiKey,
    openrouterApiKey,
    langfuse: {
      enabled: langfuseEnabled,
      baseUrl: env.LANGFUSE_BASE_URL,
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
    },
    browser: { backend: backendResult.data, channel: env.BROWSER_CHANNEL },
    maxRepair,
    testCaseLanguage,
  };
}
