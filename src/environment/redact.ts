/**
 * Redaction for everything the environment feature (and a run that uses it) writes: progress, run.log, error
 * messages, validation errors. Two layers: the exact secret VALUES of this run, and the shapes that carry a
 * secret whatever its value (`password=…`, `"token": "…"`, `otp: 123456`, `Authorization: Basic …`, `user:pass@`).
 */
export const REDACTED = "[REDACTED]";

// key[:=]value — the key may be quoted (JSON) and prefixed (`DB_PASSWORD`); the value may be quoted (spaces allowed) or a bare run.
const KEY_VALUE =
  /(["']?\b[\w-]*(?:password|passwd|pwd|passphrase|token|otp|secret|api[-_]?key)[\w-]*\b["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&"'}\]]+)/gi;
const AUTH_HEADER = /\b(authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s"',;]+/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** `shapes: false` masks only the exact secret values (for free-form progress text where `tokens: 120` is just a count). */
export function redact(text: string, secrets: readonly string[] = [], shapes = true): string {
  let out = text;
  // Longest first, so a secret that contains another one is masked whole.
  for (const s of [...new Set(secrets)].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(REDACTED);
  }
  if (!shapes) return out;
  out = out.replace(AUTH_HEADER, `$1${REDACTED}`);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(KEY_VALUE, (_m, head: string) => `${head}${REDACTED}`);
  return out;
}

/** Every representation of a Basic Auth pair that may show up in a log or a header dump. */
export function basicAuthSecrets(username: string, password: string): string[] {
  const pair = `${username}:${password}`;
  return [password, pair, Buffer.from(pair).toString("base64")];
}
