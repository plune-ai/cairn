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
  /(?<![\p{L}\p{N}])(?:pass(?:words?|wd|phrase|code)?|pwd|secrets?|tokens?|(?:api)?keys?|otp|pin|пін|пин|credentials?|creds|парол\p{L}*|токен\p{L}*|секрет\p{L}*|ключ\p{L}*|креденшел\p{L}*|облікові\s+дані|учетные\s+данные)(?![\p{L}\p{N}])/iu;

// A label whose HEAD word is a secret word names the secret itself. English puts the head last ("Admin
// password", "Stripe key", "PIN code"); Ukrainian/Russian first or last, in the nominative ("Пароль
// адміністратора", "Тестовий пароль", "ПІН-код") — "Password rules" and "Правила пароля" only talk about one.
const EN_SECRET_HEAD =
  /(?:^|[^\p{L}\p{N}])(?:pass(?:words?|wd|phrase|code)?|pwd|secrets?|tokens?|keys?|(?:otp|pin)(?:[\s-]?code)?|credentials?|creds)$/iu;
const SLAVIC_HEAD =
  "(?:парол[ьіи]|токен[иы]?|секрет[иы]?|ключ[іи]?|креденшел[иі]|облікові\\s+дані|учетные\\s+данные|(?:otp|pin|пін|пин)(?:-?код)?)";
const SLAVIC_SECRET_HEAD = new RegExp(`^${SLAVIC_HEAD}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${SLAVIC_HEAD}$`, "iu");
/**
 * "Forgot password", "Change password", "Змінити пароль" name a feature or a link; "Empty password", "Wrong
 * password", "Порожній пароль" a test condition (`Empty password: "Password is required"` quotes a message) —
 * none of them the secret.
 */
const ACTION_HEAD =
  /(?:^|[^\p{L}\p{N}])(?:forgot(?:ten)?|reset|change|recover|restore|update|show|hide|toggle|remember|manage|edit|empty|blank|wrong|invalid|incorrect|short|weak|missing|забули|змінити|скинути|відновити|показати|сховати|приховати|порожн\p{L}*|невірн\p{L}*|неправильн\p{L}*|коротк\p{L}*|слаб\p{L}*|изменить|сменить|поменять|сбросить|восстановить|забыли|показать|скрыть|пуст\p{L}*|неверн\p{L}*)(?:\s+(?:your|the|my|свій|ваш|свой))?\s+\S+$/iu;

type Head = "password" | "passphrase" | "credentials" | "code" | "other";

/** Env names that end in a secret word (`DB_PASS`, `GITHUB_TOKEN`, `STRIPE_KEY`) or carry SECRET / PASSWORD
 * anywhere (`SECRET_KEY_BASE`) — not `TOKEN_TTL`, not a public key. */
const SECRET_ENV = /(?:^|_)(?:PASS(?:WORDS?|WD|PHRASE|CODE)?|PWD|SECRETS?|TOKENS?|KEYS?|OTP|PIN|CREDENTIALS?|CREDS)$|SECRET|PASSWORD/i;
/** …of which a password variable counts whatever its value looks like (`DB_PASSWORD=postgres`). */
const PASSWORD_ENV = /(?:^|_)(?:PASS(?:WORDS?|WD|PHRASE|CODE)?|PWD)$/i;
const PUBLIC_ENV = /(?:^|_)(?:PUBLIC|PUBLISHABLE)_KEYS?$/i;
/** Never a secret: flags, and the words a field list puts after "Password:". */
const TRIVIAL =
  /^(?:true|false|yes|no|on|off|null|none|undefined|empty|blank|enabled|disabled|required|optional|hidden|visible|masked|mandatory|обов['’]язков\p{L}*|необов['’]язков\p{L}*|порожн\p{L}*|пуст\p{L}*)$/iu;

/** Drops trailing characters of a class — a loop, not a `[…]+$` pattern, which rescans a long run from every position. */
const trimEnd = (s: string, cls: RegExp): string => {
  let end = s.length;
  while (end > 0 && cls.test(s[end - 1]!)) end -= 1;
  return s.slice(0, end);
};
/** Markdown, quotes and punctuation around a label or a value: `**Password:**`, `` `sk-…` ``, `«…»`, `(admin)`. */
const strip = (s: string): string => trimEnd(s.trim().replace(/^[\s*_`"'([«“„‘]+/u, ""), /[\s*_`"')\].,;:»”’]/u);

/** A value written in quotes is meant literally (single quotes excluded: they are apostrophes too). */
const QUOTED = /[`"«“„]([^`"«»“”„\n]{4,})[`"»”“]/gu;
/** …and a value that STARTS with a quote is that quote, spaces and all: `Password: "correct horse battery"`. */
const QUOTED_VALUE = /^[`"«“„]([^`"«»“”„\n]{4,})[`"»”“]/u;
/** A column that describes a field or records a result rather than holding its value: `| Field | Type |`,
 * `| Поле | Роль |`, `| Status |`, `| Min |` — from a word start, so `Information` is not `format`, and a bound as a
 * whole word (`Minimum`, `Мінімальне значення`), so `Maxim` stays a name. */
const SPEC_COLUMN =
  /(?<![\p{L}\p{N}])(?:type|role|kind|format|rule|validat|constraint|selector|locator|element|widget|controls?(?!\p{L})|descri|note|comment|behavio|expect|status|result|actual|length|тип|роль|формат|правил|валідац|валидац|опис|примітк|примечан|очікуван|ожидаем|селектор|локатор|елемент|элемент|статус|результат|фактичн|довжин|длин|(?:(?:min|max)(?:imum|imal)?|мін(?:імум|імальн\p{L}*)?|мин(?:имум|имальн\p{L}*)?|макс(?:имум|имальн\p{L}*)?)(?!\p{L}))/iu;
/** A type word describes a field and is never a secret: `| Password | textbox |`, `Password: password` — a password
 * `password` protects nothing, and taking it would cut the word out of every state. */
const SPEC_WORD =
  /^(?:password|text|textbox|textarea|string|email|e-mail|number|numeric|integer|int|boolean|bool|checkbox|radio|input|field|button|select|combobox|date|datetime|tel|url|search|пароль|текст|рядок|строка|число)$/iu;
/** A first header cell that makes every column an instance: `| | Staging | Production |`, `| Role | Admin | Viewer |`. */
const MATRIX_HEAD =
  /(?<![\p{L}\p{N}])(?:environment|env(?!\p{L})|account|role|user|середовищ|оточенн|окружени|акаунт|роль|користувач)/iu;
/** …as do columns that all name an environment: `| Parameter | Staging | Production |`. */
const ENV_NAME =
  /^(?:staging|stage|stg|prod|production|dev|development|qa|test|testing|uat|local|demo|sandbox|pre-?prod|beta|integration|live|тест|прод|дев|стейдж\p{L}*)$/iu;
/** Outside a matrix, a column named for the value holds it: `| Field | Required | Value |`, `| Test data |`. */
const VALUE_COLUMN = /(?<![\p{L}\p{N}])(?:value|example|data|значен|приклад|пример|дані|данные)/iu;

/** A key–value table's layout, read once from its header: which columns describe the field, whether every other
 * column holds a value (a matrix), and the column named for the value. */
const tableLayout = (header: string[]): { spec: boolean[]; matrix: boolean; named: number | undefined } => {
  const spec = header.map((h) => SPEC_COLUMN.test(h));
  const values = header.flatMap((h, i) => (i > 0 && !spec[i] ? [i] : []));
  const matrix = !header[0] || MATRIX_HEAD.test(header[0]) || values.every((i) => ENV_NAME.test(strip(header[i]!)));
  return { spec, matrix, named: values.find((i) => VALUE_COLUMN.test(header[i]!)) };
};

/**
 * Shaped like a credential rather than a word: letters mixed with digits (not "6-digit"), or a symbol other
 * than a word's own hyphen, apostrophe or dot, or a closing "?"/"!" (not "e-mail", "one-time", "password?");
 * all digits (a PIN) only when asked.
 */
function credentialShaped(t: string, digitsOnly = false): boolean {
  if (t.length < 4 || TRIVIAL.test(t)) return false;
  if (/^\p{N}+$/u.test(t)) return digitsOnly;
  if (/\p{L}/u.test(t) && /\p{N}/u.test(t)) return !/^\p{N}+[-‑–]\p{L}+$/u.test(t);
  return /[^\p{L}\p{N}\-‑–'’ʼ.]/u.test(trimEnd(t, /[?!]/u));
}

/** Parenthesised commentary out: "Password (admin)", "(the admin's)". `[^()]` keeps an unclosed "(" run linear. */
const dropParens = (s: string): string => s.replace(/\([^()]*\)/g, " ");

function secretHead(rawLabel: string): Head | undefined {
  const label = strip(dropParens(rawLabel)).replace(/\s+(?:for|of)\s.*$/i, ""); // "… for the admin"
  const m = EN_SECRET_HEAD.exec(label) ?? SLAVIC_SECRET_HEAD.exec(label);
  if (!m) return undefined;
  const w = m[0].toLowerCase();
  const head: Head = /phrase/.test(w)
    ? "passphrase"
    : /otp|pin|пін|пин|код|code/.test(w)
      ? "code"
      : /pass|pwd|парол/.test(w)
        ? "password"
        : /cred|креденшел|дані|данные/.test(w)
          ? "credentials"
          : "other";
  // "Forgot password: /forgot-password", "Empty password: "…"" — but "Reset PIN: 4711" is still a code (digits only)
  return head !== "code" && ACTION_HEAD.test(label) ? undefined : head;
}

/** What a value under a secret head adds, whatever the rest of the line says. */
function headValues(head: Head, value: string): string[] {
  const quoted = QUOTED_VALUE.exec(value.trim())?.[1];
  const v = quoted ?? strip(dropParens(value));
  if (head !== "passphrase" && /^\/|:\/\//.test(v)) return []; // a path or a URL names a page, not a secret
  const first = strip(v.split(/[\s,;]+/)[0] ?? "");
  const pair = v.split("/").map((p) => p.trim()); // "login / password"
  switch (head) {
    case "passphrase":
      return [v]; // spaces are part of it
    case "password":
    case "credentials":
      if (pair.length === 2) return [strip(pair[1]!)]; // "Email / password: qa@acme.test / qwerty"
      if (head === "credentials") return [];
      return quoted !== undefined || !/\s/.test(v) ? [v] : []; // a weak password is still one — but "required, 8-64 characters" is prose
    case "code":
      return credentialShaped(first, true) ? [first] : []; // "PIN: 4711, same for all" — not "6-digit code…"
    case "other":
      // "Key: abcd-1234", "API key = `sk-live-abcdef`" — not "Sort key: name", nor `Sort key: "name"`
      if (quoted !== undefined && !/\s/.test(v) && /[-_]/.test(v)) return [v];
      return credentialShaped(first) ? [first] : [];
  }
}

/** `label: value`, `label = value` or `label — value` / `label - value`; bullets and quotes tolerated. */
const LINE = /^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(.{1,60}?)(?:\s*[:=：]|\s+[—–]|\s+-(?=\s))\s*(.+)$/u;
/**
 * A login written next to its credential with no label at all: "Test account: qa@acme.test / Qwerty123!". The
 * lookbehind starts a match only at a token's first character — without it a long run of word characters is
 * rescanned from every position.
 */
const LOGIN_PAIR = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\s*\/\s*(\S+)/gu;
/**
 * "Login: admin / Password: qwerty", "User: qa@acme.test, Password: qwerty", "Admin - Password: qwerty" — one label
 * per segment; a dash only splits before another "label:".
 */
const SEGMENT = /(?:[,;]|\s[/|—–-])\s+(?=[^,;:]{1,40}[:=：])/;

export function secretValues(knowledgeText: string, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  const add = (v: string): void => {
    const s = strip(v);
    if (s.length >= 4 && !TRIVIAL.test(s) && !SPEC_WORD.test(s)) out.add(s);
  };
  // A Markdown table: the row above its |---| rule is the header; a header cell naming a secret marks a column.
  let above: string[] = [];
  let table: ReturnType<typeof tableLayout> | undefined; // undefined until the rule: a row above it may be the header
  let columns: { at: number; head: Head | undefined }[] = [];
  for (const line of knowledgeText.split(/\r?\n/)) {
    for (const p of line.matchAll(LOGIN_PAIR)) {
      const v = strip(p[1] ?? "");
      // Not a second login ("viewer@… / editor@…"), not a phone number ("qa@… / +380 44 …").
      if (!v.includes("@") && !/^\+?[\d()-]+$/.test(v) && credentialShaped(v)) add(v);
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))) {
        columns = above.flatMap((c, at) => (SECRET_WORD.test(c) ? [{ at, head: secretHead(c) }] : []));
        table = tableLayout(above);
        continue;
      }
      above = cells;
      for (const { at, head } of columns) {
        const cell = cells[at] ?? ""; // | admin | admin@acme.test | Adm1n!2024 |
        for (const v of head ? headValues(head, cell) : []) add(v);
        for (const t of cell.split(/[\s,;/]+/)) if (credentialShaped(strip(t))) add(t);
      }
      // A key–value row — | Password | qwerty | — holds one value: in the column named for it (| Value |, | Test data |),
      // else in the first that neither describes the field (| Type |, | Status |) nor holds a flag (| yes |) or nothing.
      // The columns past it hold results or translations (| error |, | Passwort |); a matrix holds one per column.
      const rowHead = table && cells[0] ? secretHead(cells[0]) : undefined;
      if (table && rowHead) {
        const { spec, matrix, named } = table;
        const values = cells.flatMap((_, i) => (i > 0 && !spec[i] ? [i] : []));
        const at = matrix ? values : [named ?? values.find((i) => cells[i] && !TRIVIAL.test(cells[i]!))];
        for (const i of at) if (i !== undefined) for (const v of headValues(rowHead, cells[i] ?? "")) add(v);
      }
    } else {
      above = [];
      table = undefined;
      columns = [];
    }
    const at = line.search(SECRET_WORD);
    if (at < 0) continue;
    // Everything after the secret word may hold it — "(password: Adm1n!2024)" included.
    const after = line.slice(at);
    for (const t of after.split(/[\s,;|/:]+/)) if (credentialShaped(strip(t))) add(t);
    // A Markdown heading is a title, not "label: value" — "## Passwords - staging" names a section.
    for (const seg of /^\s*#/.test(line) ? [] : line.split(SEGMENT)) {
      const m = LINE.exec(seg);
      const head = m?.[1] && m[2] ? secretHead(m[1]) : undefined;
      if (head) for (const v of headValues(head, m![2]!)) add(v);
    }
    // Any other quote on the line counts only when it looks like a credential — "Forgot password?" does not.
    for (const q of after.matchAll(QUOTED)) {
      const v = q[1] ?? "";
      if (v.split(/\s+/).some((w) => credentialShaped(strip(w)))) add(v);
    }
  }
  for (const [k, v] of Object.entries(env)) {
    // PWD is the working directory, not a password.
    if (!v || k === "PWD" || !SECRET_ENV.test(k) || PUBLIC_ENV.test(k)) continue;
    const t = v.trim();
    // An env value is not prose: API_TOKEN=Welcome! is the token, closing "!" and all — VITE_STORAGE_KEY=user is not.
    if (PASSWORD_ENV.test(k) || credentialShaped(t, true) || /[?!]$/.test(t)) add(v);
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
