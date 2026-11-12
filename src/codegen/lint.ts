import type { GeneratedSuite } from "./schema.js";

/** #226: kinds that are errors, not advice: they go into the repair loop before the suite is even run. */
export type ERROR_KIND = "mouse-click" | "force-click" | "blind-position" | "ambiguous-locator";

export interface LintFinding {
  file: string;
  kind: "fragile-locator" | "prefer-role" | "bad-wait" | ERROR_KIND;
  detail: string;
}

// CSS/XPath/positional locators — fragile vs role+name (high severity).
const CSS_OR_XPATH = /\.locator\(|page\.\$\(|xpath=|>>|:nth-/;
// test-id — acceptable fallback but role+name is preferred (mid severity).
const TEST_ID = /getByTestId\(/;
// fixed sleeps + networkidle — flaky vs web-first auto-retrying assertions (high severity).
const BAD_WAIT = /waitForTimeout\(|waitForLoadState\(\s*['"]networkidle/;

const snippet = (line: string): string => line.trim().slice(0, 120);

function scanLine(file: string, line: string): LintFinding[] {
  const out: LintFinding[] = [];
  if (TEST_ID.test(line)) {
    out.push({ file, kind: "prefer-role", detail: `getByTestId — prefer getByRole({ name }); test-id only without an accessible name: ${snippet(line)}` });
  }
  if (CSS_OR_XPATH.test(line)) {
    out.push({ file, kind: "fragile-locator", detail: `CSS/XPath locator — replace with getByRole/getByLabel/getByText: ${snippet(line)}` });
  }
  if (BAD_WAIT.test(line)) {
    out.push({ file, kind: "bad-wait", detail: `waitForTimeout/networkidle — use web-first await expect(locator).toBeVisible(): ${snippet(line)}` });
  }
  return out;
}

/** One file read as code: for each line its code without strings and comments, its comment text and its strings. */
interface Scanned {
  code: string[];
  comment: string[];
  strings: string[][];
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** After one of these (or at the start), a `/` begins a regex literal, not a division. */
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "await", "yield"]);

/**
 * #226 review: reads a whole file once, so a string, a template or a regex that does not end where a naïve reader
 * thinks (a regex with an apostrophe, a template over several lines) cannot hide the code after it. A string is kept in
 * the code as its quotes, with its text only when the text is an identifier (`'force'`, `'first'`): a quoted key or a
 * bracketed method is then still code. A template's `${…}` is read as code.
 */
function scan(src: string): Scanned {
  const out: Scanned = { code: [""], comment: [""], strings: [[]] };
  let ln = 0;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re";
  let mode: Mode = "code";
  /** One entry per open `${`: how many `{` are open inside it. */
  const interp: number[] = [];
  let buf = "";
  let prev = ""; // the last code character that is not a space
  let word = ""; // the identifier that ends the code read so far
  const emit = (c: string): void => {
    out.code[ln] += c;
    if (c.trim()) {
      prev = c;
      word = /[\w$]/.test(c) ? word + c : "";
    }
  };
  const closeString = (q: string): void => {
    out.strings[ln]!.push(buf);
    emit(q + (IDENT.test(buf) ? buf : "") + q);
    buf = "";
    mode = "code";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "\n") {
      if (mode === "line") mode = "code";
      if (mode === "sq" || mode === "dq" || mode === "re") closeString(mode === "re" ? "/" : "'"); // unterminated: ends with the line
      if (mode === "tpl" && buf) {
        out.strings[ln]!.push(buf);
        buf = "";
      }
      ln += 1;
      out.code.push("");
      out.comment.push("");
      out.strings.push([]);
      continue;
    }
    switch (mode) {
      case "line":
      case "block":
        if (mode === "block" && c === "*" && n === "/") {
          mode = "code";
          out.comment[ln] += " ";
          i += 1;
        } else out.comment[ln] += c;
        break;
      case "sq":
      case "dq":
        if (c === "\\") {
          buf += src[i + 1] ?? "";
          i += 1;
        } else if (c === (mode === "sq" ? "'" : '"')) closeString(c);
        else buf += c;
        break;
      case "re": {
        if (c === "\\") i += 1;
        else if (c === "[") {
          // a class: a `/` inside it does not end the regex
          while (i + 1 < src.length && src[i + 1] !== "]" && src[i + 1] !== "\n") i += src[i + 1] === "\\" ? 2 : 1;
          i += 1;
        } else if (c === "/") {
          while (/[a-z]/i.test(src[i + 1] ?? "")) i += 1; // flags
          emit("/r/");
          mode = "code";
        }
        break;
      }
      case "tpl":
        if (c === "\\") {
          buf += src[i + 1] ?? "";
          i += 1;
        } else if (c === "`") {
          out.strings[ln]!.push(buf);
          buf = "";
          emit("``");
          mode = "code";
        } else if (c === "$" && n === "{") {
          out.strings[ln]!.push(buf);
          buf = "";
          interp.push(0);
          mode = "code";
          i += 1;
        } else buf += c;
        break;
      case "code":
        if (c === "/" && n === "/") {
          mode = "line";
          i += 1;
        } else if (c === "/" && n === "*") {
          mode = "block";
          i += 1;
        } else if (c === "/" && (prev === "" || BEFORE_REGEX.has(prev) || KEYWORDS_BEFORE_REGEX.has(word))) {
          mode = "re";
        } else if (c === "'" || c === '"') {
          mode = c === "'" ? "sq" : "dq";
        } else if (c === "`") {
          mode = "tpl";
        } else if (interp.length > 0 && c === "{") {
          interp[interp.length - 1]! += 1;
          emit(c);
        } else if (interp.length > 0 && c === "}") {
          if (interp[interp.length - 1] === 0) {
            interp.pop();
            mode = "tpl";
          } else {
            interp[interp.length - 1]! -= 1;
            emit(c);
          }
        } else emit(c);
        break;
    }
  }
  if (mode === "tpl" && buf) out.strings[ln]!.push(buf);
  for (let i = 0; i < out.comment.length; i++) out.comment[i] = out.comment[i]!.trim();
  return out;
}

/**
 * A comment that says something: at least one word of three letters. «//» or «// x» is not a reason, and neither is a
 * note that the work is not done (`TODO`, `FIXME`, `XXX`, `HACK`, `TBD`) or a tool directive (`eslint-disable…`,
 * `@ts-…`, `prettier-ignore`).
 */
const isReason = (comment: string): boolean =>
  /\p{L}{3,}/u.test(comment) && !/^(?:TODO|FIXME|XXX|HACK|TBD)\b|^(?:eslint-|@ts-|prettier-ignore|istanbul\s)/i.test(comment.replace(/^[\s*]+/, ""));

const clickOn = (names: string[]): RegExp => new RegExp(String.raw`(?<![\w$.])(?:[\w$]+\s*\.\s*)?(?:${names.join("|")})\s*\.\s*(?:click|dblclick)\s*\(`);
/** `force: true` (also a quoted key, `!0`, `1`). */
const FORCE = /\bforce['"]?\s*:\s*(?:true|!0|1)\b/;
/** A shorthand `{ force }` / `{ …, force }` — an error when the file sets `force` to true. */
const FORCE_SHORTHAND = /[{,]\s*force\s*[,}]/;
const FORCE_TRUE = /\bforce\s*=\s*(?:true|!0|1)\b/;
/** `.first()`, `.last()`, `.nth(`, and the bracketed forms `['first']()`. */
const POSITION = /\.\s*(?:first|last)\s*\(\s*\)|\.\s*nth\s*\(|\[\s*['"`](?:first|last|nth)['"`]\s*\]\s*\(/;
/** A position written inside a Playwright selector string: `>> nth=0`, `:nth-match(li, 2)`. */
const SELECTOR_POSITION = /(?:>>\s*)?\bnth\s*=\s*-?\d|:nth-match\(/;

/** `page.mouse` given another name: `const m = page.mouse`, `const { mouse: m } = page`. */
function mouseAliases(code: string): string[] {
  const out = new Set<string>(["mouse"]);
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\s*\.\s*)+mouse\b(?!\s*[.(\w$])/g)) out.add(m[1]!);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*[\w$.]+/g)) {
    const alias = /(?:^|,)\s*mouse\s*:\s*([A-Za-z_$][\w$]*)/.exec(m[1]!)?.[1];
    if (alias) out.add(alias);
  }
  return [...out];
}

/** What the lint knows of the page's elements: a verified element, reduced to what it checks. */
export interface KnownElement {
  role: string;
  name?: string;
  count: number;
  ambiguous?: true;
  narrowedBy?: unknown;
  offViewport?: true;
}

const GET_BY_ROLE_CALL = /getByRole\(\s*(['"])(\w+)\1\s*,\s*\{\s*name:\s*(['"])((?:\.|(?!\3).)*)\3([^}]*)\}\s*\)/g;

/**
 * Why a `getByRole(role, { name })` on `line` does not resolve to one visible element, judged by the elements read from
 * the page: several visible ones that nothing narrows, one outside the viewport, or a name that is part of another
 * element's name without `exact: true`. A call reached through another locator (`getByRole('dialog').getByRole(...)`)
 * is scoped, so it is left alone.
 */
function ambiguousLocators(line: string, known: readonly KnownElement[]): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(GET_BY_ROLE_CALL)) {
    if (/\)\s*\.\s*$/.test(line.slice(0, m.index))) continue;
    const role = m[2]!;
    const name = m[4]!.replace(/\\(.)/g, "$1");
    const same = known.filter((k) => k.role === role && k.name === name);
    const bad = same.find((k) => k.ambiguous || (k.count > 1 && !k.narrowedBy));
    if (bad) out.push(`getByRole('${role}', { name: '${name}' }) matches ${bad.count} visible elements and nothing narrows it: reach it through its dialog, row or section`);
    else if (same.some((k) => k.offViewport)) out.push(`getByRole('${role}', { name: '${name}' }) is outside the viewport and cannot be clicked`);
    else if (same.length > 0 && !/exact:\s*true/.test(m[5] ?? "")) {
      const longer = known.find((k) => k.role === role && k.name && k.name.length > name.length && k.name.toLowerCase().includes(name.toLowerCase()));
      if (longer) out.push(`getByRole('${role}', { name: '${name}' }) also matches "${longer.name}": add exact: true`);
    }
  }
  return out;
}

/**
 * #226: errors in generated code, found before the suite is run. A pointer click at coordinates (also through an alias
 * of `page.mouse`), a click forced past the actionability checks (also through a quoted key or a shorthand of a true
 * variable that a spread carries), and a position picked blindly (`.first()`, `.last()`, `.nth(`, their bracketed
 * forms, `>> nth=` in a selector) hide a wrong element behind a green test. A position is allowed with a comment on
 * the same line or on the line above that says why the position is the point of the check (sorting, say). Strings and
 * comments are not read as code.
 */
export function lintErrors(suite: GeneratedSuite, known: readonly KnownElement[] = []): LintFinding[] {
  const out: LintFinding[] = [];
  for (const f of suite.files) {
    const lines = f.content.split("\n");
    const { code, comment, strings } = scan(f.content);
    const all = code.join("\n");
    const mouse = clickOn(mouseAliases(all));
    const forceSet = FORCE_TRUE.test(all);
    let aboveReason = false; // the line above is a comment that says something
    code.forEach((c, i) => {
      const where = `line ${i + 1}: ${snippet(lines[i] ?? "")}`;
      if (mouse.test(c)) {
        out.push({ file: f.path, kind: "mouse-click", detail: `page.mouse.click clicks at coordinates, not at an element — click the element's locator (${where})` });
      }
      if (FORCE.test(c) || (forceSet && FORCE_SHORTHAND.test(c))) {
        out.push({ file: f.path, kind: "force-click", detail: `force: true skips the actionability checks, so it clicks what is hidden or covered — wait for the element instead (${where})` });
      }
      for (const d of c.trim() ? ambiguousLocators(lines[i] ?? "", known) : []) {
        out.push({ file: f.path, kind: "ambiguous-locator", detail: `${d} (line ${i + 1}: ${snippet(lines[i] ?? "")})` });
      }
      const position = POSITION.test(c) || strings[i]!.some((t) => SELECTOR_POSITION.test(t));
      if (position && !isReason(comment[i]!) && !aboveReason) {
        out.push({
          file: f.path,
          kind: "blind-position",
          detail: `.first() / .last() / .nth() picks by position — narrow by context (the row, card or section's name: getByRole('row', { name: /Jane/ }).getByRole('button', { name: 'Delete' })), or add a comment saying why the position is the point of the check (${where})`,
        });
      }
      aboveReason = c.trim() === "" && isReason(comment[i]!);
    });
  }
  return out;
}

/** Deterministic anti-pattern scan of generated specs (no I/O, never throws). Source of truth for "fragile". */
export function lintSuite(suite: GeneratedSuite): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const f of suite.files) {
    for (const line of f.content.split("\n")) findings.push(...scanLine(f.path, line));
  }
  return [...findings, ...lintErrors(suite)];
}

/** Format findings as a repair-hint block. Empty string when clean → a no-op when appended to a hint. */
export function lintHint(findings: LintFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((x) => `- [${x.kind}] ${x.file}: ${x.detail}`);
  return `Flaky-hardening — fix these fragile patterns:\n${lines.join("\n")}`;
}
