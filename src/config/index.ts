import {
  BrowserBackendSchema,
  LlmProfileSchema,
  ModelsConfigSchema,
  ProviderSchema,
  RoleSchema,
} from "./schema.js";
import type { AppConfig, Provider, ModelTier, RolesConfig } from "./schema.js";
import { PROFILES, ROUTING_PRESETS } from "./profiles.js";
import { createEnvReader } from "./env.js";

export type { AppConfig, ModelsConfig, ModelTier, Provider, LlmProfile, BrowserBackend, Role, RoleModel, RolesConfig } from "./schema.js";

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
  const groqApiKey = read("GROQ_API_KEY"); // L1-02 — Groq key (also via CAIRN_GROQ_API_KEY).
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

  // L1-01 (ADR-0011): optional per-role routing, additive over the tier map. Preset via
  // LLM_ROUTING + explicit CAIRN_ROLE_<NAME> overrides. Unknown roles/presets warn and fall
  // back to the tier default; a routed role with a missing provider key errors by role+provider.
  const warn = opts.warn ?? ((msg: string): void => { process.stderr.write(`${msg}\n`); });
  const roles = parseRoles(env, read, warn);
  if (roles) {
    for (const [role, tier] of Object.entries(roles)) {
      if (!tier) continue;
      if (tier.provider === "anthropic" && !anthropicApiKey) {
        throw new Error(`Role '${role}' uses Anthropic, but ANTHROPIC_API_KEY is not set.`);
      }
      if (tier.provider === "openrouter" && !openrouterApiKey) {
        throw new Error(`Role '${role}' uses OpenRouter, but OPENROUTER_API_KEY is not set.`);
      }
      if (tier.provider === "groq" && !groqApiKey) {
        throw new Error(`Role '${role}' uses Groq, but GROQ_API_KEY is not set.`);
      }
    }
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
    roles,
    anthropicApiKey,
    openrouterApiKey,
    groqApiKey,
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

/**
 * L1-01: build the optional per-role routing map (worker/reasoner) from a named preset
 * (`LLM_ROUTING`) plus explicit `CAIRN_ROLE_<NAME>=provider:model` overrides (which win over
 * the preset). Unknown presets and unknown role names warn and are ignored (graceful fallback
 * to the tier default). Returns undefined when no routing is configured.
 */
function parseRoles(
  env: Env,
  read: (name: string) => string | undefined,
  warn: (msg: string) => void,
): RolesConfig | undefined {
  const roles: Record<string, ModelTier> = {};

  // 1) Named preset via LLM_ROUTING (e.g. "volume").
  const presetName = read("LLM_ROUTING");
  if (presetName) {
    const preset = ROUTING_PRESETS[presetName];
    if (preset) {
      for (const [role, tier] of Object.entries(preset)) {
        if (tier) roles[role] = { ...tier };
      }
    } else {
      warn(
        `[cairn] unknown LLM_ROUTING routing preset '${presetName}' — ignored ` +
          `(known: ${Object.keys(ROUTING_PRESETS).join(", ")}).`,
      );
    }
  }

  // 2) Explicit per-role overrides via CAIRN_ROLE_<NAME>=provider:model (override the preset).
  const known = RoleSchema.options as readonly string[];
  for (const key of Object.keys(env)) {
    if (!key.startsWith("CAIRN_ROLE_")) continue;
    const value = env[key];
    if (value === undefined || value.trim() === "") continue;
    const role = key.slice("CAIRN_ROLE_".length).toLowerCase();
    if (!known.includes(role)) {
      warn(`[cairn] unknown role '${role}' in ${key} — ignored (known roles: ${known.join(", ")}).`);
      continue;
    }
    roles[role] = parseRoleSpec(role, value);
  }

  return Object.keys(roles).length > 0 ? (roles as RolesConfig) : undefined;
}

/** Parse a `provider:model` role spec; throws a clear error on a bad provider or empty model. */
function parseRoleSpec(role: string, value: string): ModelTier {
  const i = value.indexOf(":");
  const providerRaw = (i === -1 ? value : value.slice(0, i)).trim();
  const model = (i === -1 ? "" : value.slice(i + 1)).trim();
  const provider = ProviderSchema.safeParse(providerRaw);
  if (!provider.success) {
    throw new Error(
      `Invalid provider '${providerRaw}' for role '${role}' (allowed: anthropic | openrouter | groq). ` +
        `Use CAIRN_ROLE_${role.toUpperCase()}=provider:model.`,
    );
  }
  if (!model) {
    throw new Error(
      `Missing model for role '${role}' — use CAIRN_ROLE_${role.toUpperCase()}=${providerRaw}:<model>.`,
    );
  }
  return { provider: provider.data, model, supportsVision: false };
}
