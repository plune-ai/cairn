/**
 * C1-01 — shared core: the single place that turns CLI flags into an {@link AppConfig}.
 *
 * Every modality command (explore today; ui/api/unit/docs tomorrow) used to repeat the same
 * `{ ...process.env }` + override + `loadConfig` dance. Centralizing it here means a new modality
 * is a thin add, not a fork, and the flag→env mapping lives in exactly one place.
 */
import { loadConfig } from "../config/index.js";
import type { AppConfig } from "../config/index.js";

type Env = Record<string, string | undefined>;

/** CLI flags shared across modality commands that influence configuration. */
export interface ConfigFlags {
  /** `--backend lib|cli` → `BROWSER_BACKEND` (browser gateway selection). */
  backend?: string;
  /** `--routing <preset>` → `LLM_ROUTING` (per-role routing preset, L1-01/ADR-0011). */
  routing?: string;
  /** `--channel <chrome|msedge>` → `BROWSER_CHANNEL` (drive a system browser; no bundled Chromium). */
  channel?: string;
}

/**
 * Resolve an {@link AppConfig} from CLI flags layered over `env` (defaults to `process.env`).
 * Pure: never mutates `env` — overrides are applied to a shallow copy. A set flag wins over the
 * corresponding env var; an absent flag leaves the env value untouched. All validation (missing
 * provider keys, bad presets, …) is delegated to {@link loadConfig}, so errors stay identical.
 */
export function resolveConfig(flags: ConfigFlags = {}, env: Env = process.env): AppConfig {
  const merged: Env = { ...env };
  if (flags.backend) merged.BROWSER_BACKEND = flags.backend;
  if (flags.routing) merged.LLM_ROUTING = flags.routing;
  if (flags.channel) merged.BROWSER_CHANNEL = flags.channel;
  return loadConfig(merged);
}
