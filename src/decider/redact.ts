/**
 * Values that must never reach a decider (spec §3.7). Cairn never PUTS knowledge, storageState,
 * screenshots or env into a state — but a designed case can ECHO a credential it read in a knowledge
 * file ("type Sup3rS3cret! into Password"), and a test error can echo a typed value. So every state is
 * scrubbed of the values that look like secrets in this run's knowledge and environment.
 */
const SECRET_WORD = /(^|[^a-z])(pass(word)?|passwd|pwd|secret|token|api[ _-]?key|key|otp|pin|credentials?)([^a-z]|$)/i;

export function secretValues(knowledgeText: string, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  // `<label>: <value>` / `<label> = <value>` lines, list bullets and quotes tolerated.
  for (const m of knowledgeText.matchAll(/^[ \t>*-]*([^:=\n]{1,40}?)\s*[:=]\s*[`"']?([^\s`"',;]{4,})/gm)) {
    if (m[2] && SECRET_WORD.test(m[1] ?? "")) out.add(m[2]);
  }
  for (const [k, v] of Object.entries(env)) if (v && v.length >= 8 && SECRET_WORD.test(k)) out.add(v);
  return [...out].sort((a, b) => b.length - a.length); // longest first: a secret containing another is scrubbed whole
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("‹redacted›");
  return out;
}
