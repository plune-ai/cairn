/**
 * MCP-E1 — what is masked in everything `cairn mcp-test` prints or saves.
 *
 * Every `--header` and `--env` value of 4 characters or more counts, whatever the name is: a server can repeat any of
 * them in a description or on stderr. The sensitive-name rules of the API guard add the parts of a credential
 * (`Bearer x` → `x`, a decoded Basic pair, cookie values). All sources go into ONE list, longest first, so a value that is
 * the start of another one cannot leave the rest of the longer one behind.
 *
 * Known limits: only the raw and URL-encoded forms are masked (not base64 or HTML forms), and a secret that is part of
 * the address path is not masked.
 */
import { collectSecrets, maskSecrets } from "../api/guard.js";

export const MIN_MASKED_LENGTH = 4;

export function buildSecrets(headers: Record<string, string>, env: Record<string, string>, extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    if (raw.length < MIN_MASKED_LENGTH) return;
    out.add(raw);
    const enc = encodeURIComponent(raw);
    if (enc !== raw) out.add(enc);
  };
  for (const map of [headers, env]) {
    for (const [name, value] of Object.entries(map)) {
      add(value);
      add(value.trim());
      collectSecrets({ [name]: value }).forEach(add);
    }
  }
  extra.forEach(add);
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** The end of `text` when it is the start of a secret (a secret cut by a size limit): replaced like a whole one. */
export function maskCutTail(text: string, secrets: readonly string[]): string {
  for (const s of secrets) {
    for (let k = Math.min(s.length - 1, text.length); k >= MIN_MASKED_LENGTH; k--) {
      if (text.endsWith(s.slice(0, k))) return `${text.slice(0, text.length - k)}***`;
    }
  }
  return text;
}

export { maskSecrets };
