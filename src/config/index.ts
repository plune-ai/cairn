import {
  BrowserBackendSchema,
  DeciderProviderSchema,
  LlmProfileSchema,
  ModelsConfigSchema,
  ProviderSchema,
  RoleSchema,
} from "./schema.js";
import type { AppConfig, Provider, ModelTier, RolesConfig } from "./schema.js";
import { PROFILES, ROUTING_PRESETS } from "./profiles.js";
import { createEnvReader } from "./env.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "../llm/structured.js";
import { DECIDER_USES, type DeciderConfig, type DeciderUse } from "../decider/types.js";

export type { AppConfig, ModelsConfig, ModelTier, Provider, LlmProfile, BrowserBackend, Role, RoleModel, RolesConfig } from "./schema.js";
export type { DeciderConfig } from "../decider/types.js";

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

  // Playwright worker count for running the generated suite (default 5; PLAYWRIGHT_WORKERS override).
  const workersRaw = read("PLAYWRIGHT_WORKERS");
  const playwrightWorkers = workersRaw === undefined ? 5 : Number(workersRaw);
  if (!Number.isInteger(playwrightWorkers) || playwrightWorkers < 1) {
    throw new Error(`Invalid PLAYWRIGHT_WORKERS='${workersRaw}'. Must be a positive integer (≥ 1).`);
  }

  // #110: per-step LLM timeout (ms). Default 240000 (4 min); 0 disables. Guards against a slow
  // provider hanging explore/design indefinitely (esp. via the MCP server).
  const stepTimeoutRaw = read("STEP_TIMEOUT_MS");
  const stepTimeoutMs = stepTimeoutRaw === undefined ? DEFAULT_STEP_TIMEOUT_MS : Number(stepTimeoutRaw);
  if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs < 0) {
    throw new Error(`Invalid STEP_TIMEOUT_MS='${stepTimeoutRaw}'. Must be a non-negative integer in ms (0 disables).`);
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

  // ADR-0022: opt-in decision layer — the key is ABSENT (not undefined) when off, so an AppConfig
  // built without DECIDER is exactly the object it was before the layer existed.
  const decider = parseDeciderConfig(read);

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
    playwrightWorkers,
    testCaseLanguage,
    stepTimeoutMs,
    ...(decider ? { decider } : {}),
  };
}

/** A number env var with a default and a validity rule; throws a clear error naming the variable. */
function envNumber(
  read: (name: string) => string | undefined,
  name: string,
  dflt: number,
  ok: (n: number) => boolean,
  rule: string,
): number {
  const raw = read(name)?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!ok(n)) throw new Error(`Invalid ${name}='${raw}'. ${rule}`);
  return n;
}

/** TypeSafe's own hosts — the only addresses `DECIDER=jev` (and its key) may go to. */
export const TYPESAFE_HOST = /(?:^|\.)typesafe\.ai$/;

/**
 * ADR-0022: the opt-in decision layer. undefined unless DECIDER names a provider — a key alone enables
 * nothing (spec §3.2). Each provider reads ONLY its own key, so a TypeSafe cloud key is never sent to a
 * laya/compat server. Misconfiguration fails here, at start, not in the middle of a run.
 */
export function parseDeciderConfig(read: (name: string) => string | undefined): DeciderConfig | undefined {
  const raw = read("DECIDER")?.trim().toLowerCase();
  if (!raw || raw === "off") return undefined;
  const parsed = DeciderProviderSchema.safeParse(raw);
  if (!parsed.success || parsed.data === "off") {
    throw new Error(`Invalid DECIDER='${raw}'. Allowed: off | jev | laya | compat.`);
  }
  const provider = parsed.data;

  // Each provider reads only its OWN address and key: jev takes TypeSafe's pair (as the SDK does), laya/compat
  // take DECIDER_*. A laya address left in .env therefore never receives the TypeSafe key.
  const urlVar = provider === "jev" ? "TYPESAFE_BASE_URL" : "DECIDER_BASE_URL";
  const keyVar = provider === "jev" ? "TYPESAFE_API_KEY" : provider === "laya" ? "LAYA_API_KEY" : "DECIDER_API_KEY";
  const baseUrl = read(urlVar)?.trim() || (provider === "jev" ? "https://api.typesafe.ai" : "");
  if (!baseUrl) {
    throw new Error(
      `DECIDER=${provider} needs DECIDER_BASE_URL — the server's address, e.g. http://127.0.0.1:8000 (see docs/decider.md).`,
    );
  }
  if (!/^https?:\/\//i.test(baseUrl) || !URL.canParse(baseUrl)) {
    // Echoed for typos, but never a credential: an unparsable `https://u:p#ss@host` still carries one.
    throw new Error(`Invalid ${urlVar}='${baseUrl.replace(/^(\w+:\/*)?.*@/, "$1***@")}' — expected an http(s) URL.`);
  }
  const url = new URL(baseUrl);
  if (url.username || url.password) {
    // Not echoed: the URL carries a credential.
    throw new Error(`Invalid ${urlVar}: a user:password in the URL is not supported — put the key in ${keyVar}.`);
  }
  // jev means TypeSafe's cloud: its key and its caps. Any other address — a laya-serve the TypeSafe SDK was
  // pointed at, a proxy — would receive the TypeSafe key and be read with Jev's 60k caps, which laya cuts silently.
  if (provider === "jev" && (url.protocol !== "https:" || !TYPESAFE_HOST.test(url.hostname))) {
    throw new Error(
      `DECIDER=jev talks only to TypeSafe (https://*.typesafe.ai), but ${urlVar} points to ${url.host}. ` +
        "For a Laya server use DECIDER=laya with DECIDER_BASE_URL; for another Jev-compatible server, DECIDER=compat. " +
        "To reach TypeSafe while TYPESAFE_BASE_URL serves the SDK elsewhere, set CAIRN_TYPESAFE_BASE_URL=https://api.typesafe.ai " +
        "and CAIRN_TYPESAFE_API_KEY (the CAIRN_ names win).",
    );
  }

  const apiKey = read(keyVar)?.trim() || undefined;
  if (provider === "jev" && !apiKey) throw new Error("DECIDER=jev needs TYPESAFE_API_KEY (your TypeSafe API key).");

  const usesRaw = read("DECIDER_USES")?.trim() || "repair-triage,coverage";
  const uses = [...new Set(usesRaw.split(",").map((s) => s.trim()).filter(Boolean))];
  for (const u of uses) {
    if (!(DECIDER_USES as readonly string[]).includes(u)) {
      throw new Error(`Unknown DECIDER_USES entry '${u}' (supported in this version: ${DECIDER_USES.join(", ")}).`);
    }
  }

  return {
    provider,
    baseUrl,
    model: read("DECIDER_MODEL")?.trim() || "jev-latest",
    ...(apiKey ? { apiKey } : {}),
    uses: uses as DeciderUse[],
    minConfidence: envNumber(read, "DECIDER_MIN_CONFIDENCE", 0.75, (n) => n >= 0 && n <= 1, "Must be a number from 0 to 1."),
    timeoutMs: envNumber(read, "DECIDER_TIMEOUT_MS", 10_000, (n) => Number.isInteger(n) && n > 0, "Must be a positive integer (ms)."),
    maxCalls: envNumber(read, "DECIDER_MAX_CALLS", 200, (n) => Number.isInteger(n) && n >= 0, "Must be a non-negative integer."),
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
