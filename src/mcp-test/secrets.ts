/**
 * MCP-E1 — what is masked in everything `cairn mcp-test` prints or saves.
 *
 * Which values count as secrets:
 * - a `--header` / `--env` value whose NAME is sensitive (`Authorization`, `*key*`, `*token*`, `*secret*`, `*password*`,
 *   cookies; the API guard's rule) from 4 characters, with the parts of a credential (`Bearer x` → `x`, a decoded Basic
 *   pair, cookie values);
 * - a value under any other name from 8 characters;
 * - never a value in the guard's COMMON_VALUES (`true`, `application/json`, …), and never a shorter one.
 * A short value under a neutral name is therefore not masked, and a long ordinary word passed as a value is replaced
 * wherever the server repeats it.
 *
 * All sources go into ONE list, longest first, so a value that is the start of another cannot leave the rest of the
 * longer one behind. Only the raw and URL-encoded forms are masked (not base64 or HTML), and a secret that is part of
 * the address path is not masked.
 */
import { COMMON_VALUES, SENSITIVE, collectSecrets, maskSecrets } from "../api/guard.js";

export const MIN_NEUTRAL_LENGTH = 8;
const MIN_TAIL_LENGTH = 4;
/** Deeper than this, {@link maskStrings} replaces the value (discovery cuts at 64, so a model never reaches it). */
const MASK_DEPTH_LIMIT = 128;

export function buildSecrets(headers: Record<string, string>, env: Record<string, string>, extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    out.add(raw);
    const enc = encodeURIComponent(raw);
    if (enc !== raw) out.add(enc);
  };
  for (const map of [headers, env]) {
    for (const [name, value] of Object.entries(map)) {
      if (SENSITIVE.test(name)) collectSecrets({ [name]: value }).forEach(add);
      else if (value.trim().length >= MIN_NEUTRAL_LENGTH && !COMMON_VALUES.has(value.trim().toLowerCase())) add(value.trim());
    }
  }
  extra.forEach(add);
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** The end of `text` when it is the start of a secret (a secret cut by a size limit): replaced like a whole one. */
export function maskCutTail(text: string, secrets: readonly string[]): string {
  for (const s of secrets) {
    for (let k = Math.min(s.length - 1, text.length); k >= MIN_TAIL_LENGTH; k--) {
      if (text.endsWith(s.slice(0, k))) return `${text.slice(0, text.length - k)}***`;
    }
  }
  return text;
}

/** The same value with the secrets masked in its STRING values only: keys, numbers, booleans and null are left alone. */
export function maskStrings<T>(value: T, secrets: readonly string[], depth = 0): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return maskSecrets(value, secrets) as T;
  if (value && typeof value === "object") {
    if (depth >= MASK_DEPTH_LIMIT) return "[nesting too deep]" as T;
    if (Array.isArray(value)) return value.map((v) => maskStrings(v, secrets, depth + 1)) as T;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, secrets, depth + 1)])) as T;
  }
  return value;
}

export { maskSecrets };
