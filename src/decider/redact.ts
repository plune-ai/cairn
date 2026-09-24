import type { Question } from "./types.js";

/**
 * Values that must never reach a decider (spec §3.7). Cairn never PUTS knowledge, storageState, screenshots
 * or env into a state — but a designed case can ECHO a credential it read in a knowledge file ("type
 * Sup3rS3cret! into Password"), and a test error can echo a typed value. So every state and every question
 * is scrubbed of the values that look like secrets in this run's knowledge and environment.
 *
 * BEST-EFFORT: a heuristic over `label: value` lines and variable names. It cannot recognise a secret nothing
 * labels, and a value it scrubs by mistake still goes out — damaged, answered worse. So it takes a label's HEAD
 * word, not any line that mentions a password: "Password rules: must contain a digit" holds no secret.
 */
// English puts the head word last: "Admin password", "Stripe key", "Key" — not "Password rules", "Key pages".
const EN_SECRET_HEAD = /(?:^|[^\p{L}\p{N}])(?:pass(?:words?|wd|phrase|code)|pwd|secrets?|tokens?|keys?|otp|pin|credentials?|creds)$/iu;
// Ukrainian/Russian put it first ("Пароль адміністратора") or last ("Тестовий пароль"), in the nominative either
// way — "Правила пароля" (password rules) has it in the genitive.
const SLAVIC_HEAD = "(?:парол[ьіи]|токен[иы]?|секрет[иы]?|ключ[іи]?|креденшел[иі]|облікові\\s+дані|учетные\\s+данные)";
const SLAVIC_SECRET_HEAD = new RegExp(`^${SLAVIC_HEAD}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${SLAVIC_HEAD}$`, "iu");

/** Env names that end in a secret word (`DB_PASS`, `GITHUB_TOKEN`, `STRIPE_KEY`) or carry SECRET / PASSWORD
 * anywhere (`SECRET_KEY_BASE`) — not `TOKEN_TTL`, not a public key. */
const SECRET_ENV = /(?:^|_)(?:PASS(?:WORDS?|WD|PHRASE|CODE)?|PWD|SECRETS?|TOKENS?|KEYS?|OTP|PIN|CREDENTIALS?|CREDS)$|SECRET|PASSWORD/i;
const PUBLIC_ENV = /(?:^|_)(?:PUBLIC|PUBLISHABLE)_KEYS?$/i;
const TRIVIAL = /^(?:true|false|yes|no|on|off|null|none|undefined|enabled|disabled)$/i;

/** Markdown and punctuation around a label or a value: `**Password:**`, `` `sk-…` ``, `(admin)`. */
const strip = (s: string): string => s.trim().replace(/^[\s*_`"'([]+|[\s*_`"')\].,;:]+$/gu, "");

function isSecretLabel(raw: string): boolean {
  const label = strip(raw.replace(/\([^)]*\)/g, " ")) // "Password (admin)"
    .replace(/\s+(?:for|of)\s.*$/i, ""); // "Password for the admin"
  return EN_SECRET_HEAD.test(label) || SLAVIC_SECRET_HEAD.test(label);
}

export function secretValues(knowledgeText: string, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  const add = (v: string): void => {
    const s = strip(v);
    if (s.length >= 4 && !TRIVIAL.test(s)) out.add(s);
  };
  for (const line of knowledgeText.split(/\r?\n/)) {
    // `<label>: <value>` / `<label> = <value>`, list bullets and quotes tolerated.
    const m = /^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(.{1,60}?)\s*[:=：]\s*(.+)$/u.exec(line);
    if (!m?.[1] || !m[2] || !isSecretLabel(m[1])) continue;
    const value = m[2].replace(/\([^)]*\)/g, " ").trim(); // "(the admin's)" is commentary
    add(value); // the whole value: a passphrase may contain spaces or commas
    for (const part of value.split(/\s+[/|]\s*|,\s+|;\s*/)) add(part); // "admin / Sup3rS3cret!"
    // The first word when it looks like a password, not prose: "Sup3rS3cret! for every test user" — not the
    // "from" of "from env E2E_PASSWORD".
    const first = strip(value.split(/\s+/)[0] ?? "");
    if (/[^\p{L}]/u.test(first)) add(first);
    for (const q of m[2].matchAll(/[`"']([^`"'\n]{4,})[`"']/g)) add(q[1] ?? ""); // "`Sup3rS3cret!` (admin)"
  }
  for (const [k, v] of Object.entries(env)) {
    // PWD is the working directory, not a password.
    if (v && k !== "PWD" && SECRET_ENV.test(k) && !PUBLIC_ENV.test(k)) add(v);
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
