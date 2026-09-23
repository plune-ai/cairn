import type { Question } from "./types.js";

/**
 * Values that must never reach a decider (spec §3.7). Cairn never PUTS knowledge, storageState, screenshots
 * or env into a state — but a designed case can ECHO a credential it read in a knowledge file ("type
 * Sup3rS3cret! into Password"), and a test error can echo a typed value. So every state and every question
 * is scrubbed of the values that look like secrets in this run's knowledge and environment.
 *
 * BEST-EFFORT: a heuristic over `label: value` lines and variable names. It errs towards scrubbing too much
 * (a damaged input is a fallback; a leaked password is not), but it cannot recognise a secret nothing labels.
 */
const SECRET_LABEL =
  /(?:^|[^\p{L}\p{N}])(?:pass(?:words?|wd|phrase|code)|pwd|secrets?|tokens?|(?:api|access|secret|private|auth)[ _-]?keys?|otp|pin|credentials?|creds|парол\p{L}*|токен\p{L}*|секрет\p{L}*|креденшел\p{L}*|облікові\s+дані|учетные\s+данные)(?=[^\p{L}\p{N}]|$)/iu;

/** Env names that END in a secret word: `DB_PASS`, `GITHUB_TOKEN`, `LANGFUSE_SECRET_KEY` — not `TOKEN_TTL`. */
const SECRET_ENV = /(?:^|_)(?:PASS(?:WORDS?|WD|PHRASE|CODE)?|PWD|SECRETS?|TOKENS?|(?:API|ACCESS|SECRET|PRIVATE|AUTH)_?KEY|OTP|PIN|CREDENTIALS?|CREDS)$/i;
const TRIVIAL = /^(?:true|false|yes|no|on|off|null|none|undefined|enabled|disabled)$/i;

/** Markdown and punctuation around a label or a value: `**Password:**`, `` `sk-…` ``, `(admin)`. */
const strip = (s: string): string => s.trim().replace(/^[\s*_`"'([]+|[\s*_`"')\].,;:]+$/gu, "");

export function secretValues(knowledgeText: string, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  const add = (v: string): void => {
    const s = strip(v);
    if (s.length >= 4) out.add(s);
  };
  for (const line of knowledgeText.split(/\r?\n/)) {
    // `<label>: <value>` / `<label> = <value>`, list bullets and quotes tolerated.
    const m = /^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(.{1,60}?)\s*[:=：]\s*(.+)$/u.exec(line);
    if (!m?.[1] || !m[2] || !SECRET_LABEL.test(strip(m[1]))) continue;
    add(m[2]); // the whole value: a password may contain spaces or commas
    for (const part of m[2].split(/\s+[/|(]\s*|,\s+|;\s*/)) add(part); // "admin / Sup3rS3cret!"
    for (const q of m[2].matchAll(/[`"']([^`"'\n]{4,})[`"']/g)) add(q[1] ?? ""); // "`Sup3rS3cret!` (admin)"
  }
  for (const [k, v] of Object.entries(env)) {
    // PWD is the working directory, not a password.
    if (v && k !== "PWD" && SECRET_ENV.test(k) && !TRIVIAL.test(v.trim()) && v.trim().length >= 4) out.add(v.trim());
  }
  return [...out].sort((a, b) => b.length - a.length); // longest first: a secret containing another is scrubbed whole
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("‹redacted›");
  return out;
}

/** The question's texts are scrubbed too; its option LABELS are the answer contract and stay as they are. */
export function redactQuestion(q: Question, secrets: readonly string[]): Question {
  const r = (t: string): string => redact(t, secrets);
  switch (q.type) {
    case "noul":
      return { ...q, instructions: r(q.instructions), criteria: { true: r(q.criteria.true), false: r(q.criteria.false) } };
    case "choice":
      return {
        ...q,
        instructions: r(q.instructions),
        options: Object.fromEntries(Object.entries(q.options).map(([k, d]) => [k, d === null ? null : r(d)])),
      };
    case "score":
      return { ...q, instructions: r(q.instructions), levels: q.levels.map(r) };
  }
}
