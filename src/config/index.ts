import {
  BrowserBackendSchema,
  LlmProfileSchema,
  ModelsConfigSchema,
} from "./schema.js";
import type { AppConfig, Provider } from "./schema.js";
import { PROFILES } from "./profiles.js";
import { createEnvReader } from "./env.js";

export type { AppConfig, ModelsConfig, ModelTier, Provider, LlmProfile, BrowserBackend } from "./schema.js";

type Env = Record<string, string | undefined>;

/**
 * Read and validate configuration from env. Pure function (env is injected for tests).
 * Throws a clear error on an invalid profile/backend or a missing key for a required provider.
 */
export function loadConfig(
  env: Env = process.env,
  opts: { warn?: (msg: string) => void } = {},
): AppConfig {
  // Resolve every var via CAIRN_ → LEXBOT_/LEX_ (deprecated) → bare name (C0-06).
  const read = createEnvReader(env, opts.warn);
  const llmProfileRaw = read("LLM_PROFILE");
  const profileResult = LlmProfileSchema.safeParse(llmProfileRaw ?? "anthropic");
  if (!profileResult.success) {
    throw new Error(
      `Invalid LLM_PROFILE='${llmProfileRaw}'. Allowed: anthropic | openrouter | mixed.`,
    );
  }
  const llmProfile = profileResult.data;
  const models = ModelsConfigSchema.parse(PROFILES[llmProfile]);

  // Which providers does this profile actually need?
  const tiers = [models.reasoning, models.bulk, models.judge];
  if (models.vision) tiers.push(models.vision);
  const providers = new Set<Provider>(tiers.map((t) => t.provider));

  const anthropicApiKey = read("ANTHROPIC_API_KEY");
  const openrouterApiKey = read("OPENROUTER_API_KEY");
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

  const browserBackendRaw = read("BROWSER_BACKEND");
  const backendResult = BrowserBackendSchema.safeParse(browserBackendRaw ?? "lib");
  if (!backendResult.success) {
    throw new Error(`Invalid BROWSER_BACKEND='${browserBackendRaw}'. Allowed: lib | cli.`);
  }

  const langfuseBaseUrl = read("LANGFUSE_BASE_URL");
  const langfusePublicKey = read("LANGFUSE_PUBLIC_KEY");
  const langfuseSecretKey = read("LANGFUSE_SECRET_KEY");
  const langfuseEnabled = Boolean(langfuseBaseUrl && langfusePublicKey && langfuseSecretKey);

  const maxRepairRaw = read("MAX_REPAIR");
  const maxRepair = maxRepairRaw === undefined ? 2 : Number(maxRepairRaw);
  if (!Number.isInteger(maxRepair) || maxRepair < 0) {
    throw new Error(`Invalid MAX_REPAIR='${maxRepairRaw}'. Must be a non-negative integer.`);
  }

  // Test-case language: default English; env override accepts a name or a code (en/uk/ua).
  const langRaw = (read("QA_TESTCASE_LANG") ?? "English").trim();
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
      baseUrl: langfuseBaseUrl,
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
    },
    browser: { backend: backendResult.data, channel: read("BROWSER_CHANNEL") },
    maxRepair,
    testCaseLanguage,
  };
}
