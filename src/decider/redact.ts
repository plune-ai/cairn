import type { Question } from "./types.js";

/**
 * Values that must never reach a decider (spec §3.7). Cairn never PUTS knowledge, storageState, screenshots
 * or env into a state — but a designed case can ECHO a credential it read in a knowledge file ("type
 * Sup3rS3cret! into Password"), and a test error can echo a typed value. So every state and every question
 * is scrubbed of the values that look like secrets in this run's knowledge and environment.
 *
 * BEST-EFFORT, weighed by what a wrong guess costs: a missed secret leaves the machine; a word scrubbed by
 * mistake damages every input it appears in. So a secret word anywhere on a line only POINTS at values, and
 * of those only credential-shaped ones are taken (`Qwerty123!`, `sk_live_…`, `admin@test`) — never a plain word
 * like `required` or `name` — unless a label whose head word names the secret says the value IS one
 * (`Password: qwerty`). A credential-shaped secret is scrubbed wherever it appears (`Qwerty123!x` included); a
 * plain one only as a whole token, so it can never eat into a longer word.
 */

// A secret word, anywhere on a line, as a whole word.
const SECRET_WORD =
  /(?<![\p{L}\p{N}])(?:pass(?:words?|wd|phrase|code)?|pwd|secrets?|tokens?|(?:api)?keys?|otp|pin|credentials?|creds|парол\p{L}*|токен\p{L}*|секрет\p{L}*|ключ\p{L}*|креденшел\p{L}*|облікові\s+дані|учетные\s+данные)(?![\p{L}\p{N}])/iu;

// A label whose HEAD word is a secret word names the secret itself. English puts the head last ("Admin
// password", "Stripe key", "PIN code"); Ukrainian/Russian first or last, in the nominative ("Пароль
// адміністратора", "Тестовий пароль", "PIN-код") — "Password rules" and "Правила пароля" only talk about one.
const EN_SECRET_HEAD =
  /(?:^|[^\p{L}\p{N}])(?:pass(?:words?|wd|phrase|code)?|pwd|secrets?|tokens?|keys?|(?:otp|pin)(?:[\s-]?code)?|credentials?|creds)$/iu;
const SLAVIC_HEAD = "(?:парол[ьіи]|токен[иы]?|секрет[иы]?|ключ[іи]?|креденшел[иі]|облікові\\s+дані|учетные\\s+данные|(?:otp|pin|пін)-?код)";
const SLAVIC_SECRET_HEAD = new RegExp(`^${SLAVIC_HEAD}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${SLAVIC_HEAD}$`, "iu");

type Head = "password" | "passphrase" | "credentials" | "code" | "other";

/** Env names that end in a secret word (`DB_PASS`, `GITHUB_TOKEN`, `STRIPE_KEY`) or carry SECRET / PASSWORD
 * anywhere (`SECRET_KEY_BASE`) — not `TOKEN_TTL`, not a public key. */
const SECRET_ENV = /(?:^|_)(?:PASS(?:WORDS?|WD|PHRASE|CODE)?|PWD|SECRETS?|TOKENS?|KEYS?|OTP|PIN|CREDENTIALS?|CREDS)$|SECRET|PASSWORD/i;
/** …of which a password variable counts whatever its value looks like (`DB_PASSWORD=postgres`). */
const PASSWORD_ENV = /(?:^|_)(?:PASS(?:WORDS?|WD|PHRASE|CODE)?|PWD)$/i;
const PUBLIC_ENV = /(?:^|_)(?:PUBLIC|PUBLISHABLE)_KEYS?$/i;
/** Never a secret: flags, and the words a field list puts after "Password:". */
const TRIVIAL =
  /^(?:true|false|yes|no|on|off|null|none|undefined|enabled|disabled|required|optional|hidden|visible|masked|mandatory|обов['’]язков\p{L}*|необов['’]язков\p{L}*)$/iu;

/** Markdown, quotes and punctuation around a label or a value: `**Password:**`, `` `sk-…` ``, `«…»`, `(admin)`. */
const strip = (s: string): string => s.trim().replace(/^[\s*_`"'([«“„‘]+|[\s*_`"')\].,;:»”’]+$/gu, "");

/** A value written in quotes is meant literally (single quotes excluded: they are apostrophes too). */
const QUOTED = /[`"«“„]([^`"«»“”„\n]{4,})[`"»”“]/gu;

/**
 * Shaped like a credential rather than a word: letters mixed with digits (not "6-digit"), or a symbol other
 * than a word's own hyphen, apostrophe or dot, or a closing "?"/"!" (not "e-mail", "one-time", "password?");
 * all digits (a PIN) only when asked.
 */
function credentialShaped(t: string, digitsOnly = false): boolean {
  if (t.length < 4 || TRIVIAL.test(t)) return false;
  if (/^\p{N}+$/u.test(t)) return digitsOnly;
  if (/\p{L}/u.test(t) && /\p{N}/u.test(t)) return !/^\p{N}+[-‑–]\p{L}+$/u.test(t);
  return /[^\p{L}\p{N}\-‑–'’ʼ.]/u.test(t.replace(/[?!]+$/u, ""));
}

function secretHead(rawLabel: string): Head | undefined {
  const label = strip(rawLabel.replace(/\([^)]*\)/g, " ")).replace(/\s+(?:for|of)\s.*$/i, ""); // "Password (admin)", "… for the admin"
  const m = EN_SECRET_HEAD.exec(label) ?? SLAVIC_SECRET_HEAD.exec(label);
  if (!m) return undefined;
  const w = m[0].toLowerCase();
  if (/phrase/.test(w)) return "passphrase";
  if (/otp|pin|пін|код|code/.test(w)) return "code";
  if (/pass|pwd|парол/.test(w)) return "password";
  if (/cred|креденшел|дані|данные/.test(w)) return "credentials";
  return "other";
}

/** What a value under a secret head adds, whatever the rest of the line says. */
function headValues(head: Head, value: string): string[] {
  const v = strip(value.replace(/\([^)]*\)/g, " ")); // "(the admin's)" is commentary
  const first = strip(v.split(/[\s,;]+/)[0] ?? "");
  const pair = v.split(/\s*\/\s*/); // "login / password"
  switch (head) {
    case "passphrase":
      return [v]; // spaces are part of it
    case "password":
    case "credentials":
      if (pair.length === 2) return [strip(pair[1]!)]; // "Email / password: qa@acme.test / qwerty"
      if (head === "credentials") return [];
      return /\s/.test(v) ? [] : [v]; // a weak password is still one — but "required, 8-64 characters" is prose
    case "code":
      return credentialShaped(first, true) ? [first] : []; // "PIN: 4711, same for all" — not "6-digit code…"
    case "other":
      return credentialShaped(first) ? [first] : []; // "Key: abcd-1234" — not "Sort key: name"
  }
}

/** `label: value`, `label = value` or `label — value`; bullets and quotes tolerated. */
const LINE = /^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(.{1,60}?)(?:\s*[:=：]|\s+[—–])\s*(.+)$/u;
/** A login written next to its credential with no label at all: "Test account: qa@acme.test / Qwerty123!". */
const LOGIN_PAIR = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\s*\/\s*(\S+)/gu;

export function secretValues(knowledgeText: string, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  const add = (v: string): void => {
    const s = strip(v);
    if (s.length >= 4 && !TRIVIAL.test(s)) out.add(s);
  };
  // A Markdown table: the row above its |---| rule is the header; a header cell naming a secret marks a column.
  let above: string[] = [];
  let columns: { at: number; head: Head | undefined }[] | undefined; // undefined until the rule is seen
  for (const line of knowledgeText.split(/\r?\n/)) {
    for (const p of line.matchAll(LOGIN_PAIR)) if (credentialShaped(strip(p[1] ?? ""))) add(p[1] ?? "");
    if (/^\s*\|/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))) {
        columns = above.flatMap((c, at) => (SECRET_WORD.test(c) ? [{ at, head: secretHead(c) }] : []));
        continue;
      }
      above = cells;
      if (columns) {
        for (const { at, head } of columns) {
          const cell = cells[at] ?? ""; // | admin | admin@acme.test | Adm1n!2024 |
          for (const v of head ? headValues(head, cell) : []) add(v);
          for (const t of cell.split(/[\s,;/]+/)) if (credentialShaped(strip(t))) add(t);
        }
        const rowHead = cells[0] ? secretHead(cells[0]) : undefined; // a key–value row: | Password | qwerty |
        if (rowHead && cells[1]) for (const v of headValues(rowHead, cells[1])) add(v);
      }
    } else {
      above = [];
      columns = undefined;
    }
    const at = line.search(SECRET_WORD);
    if (at < 0) continue;
    // Everything after the secret word may hold it — "(password: Adm1n!2024)" included.
    const after = line.slice(at);
    for (const t of after.split(/[\s,;|/:]+/)) if (credentialShaped(strip(t))) add(t);
    // Each "label: value" segment of the line: "User: qa@acme.test, Password: qwerty".
    let headed = false;
    for (const seg of line.split(/[,;]\s+(?=[^,;:]{1,40}[:=：])/)) {
      const m = LINE.exec(seg);
      const head = m?.[1] && m[2] ? secretHead(m[1]) : undefined;
      if (head) {
        headed = true;
        for (const v of headValues(head, m![2]!)) add(v);
      }
    }
    // Quotes are literal — a password in them counts; a button label or a message in them does not.
    for (const q of after.matchAll(QUOTED)) {
      const v = q[1] ?? "";
      if (headed || v.split(/\s+/).some((w) => credentialShaped(strip(w)))) add(v);
    }
  }
  for (const [k, v] of Object.entries(env)) {
    // PWD is the working directory, not a password.
    if (!v || k === "PWD" || !SECRET_ENV.test(k) || PUBLIC_ENV.test(k)) continue;
    if (PASSWORD_ENV.test(k) || credentialShaped(v.trim(), true)) add(v); // not VITE_STORAGE_KEY=user
  }
  return [...out].sort((a, b) => b.length - a.length); // longest first: a secret containing another is scrubbed whole
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    // A credential-shaped secret anywhere — a negative case's "Qwerty123!x" still carries it; a plain word or a
    // PIN only as a whole token, so a scrubbed "qwerty" never eats into "qwertyuiop", nor "4711" into "14711".
    out = credentialShaped(s)
      ? out.split(s).join("‹redacted›")
      : out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, "gu"), "‹redacted›");
  }
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
