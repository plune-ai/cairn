import type { GeneratedSuite } from "./schema.js";

/** #226: kinds that are errors, not advice: they go into the repair loop before the suite is even run. */
export type ERROR_KIND = "mouse-click" | "force-click" | "blind-position";

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

/** The code of a line without its strings, and the text of the comments in it. `inBlock`: the line starts inside a block comment. */
function splitLine(line: string, inBlock: boolean): { code: string; comment: string; inBlock: boolean } {
  let code = "";
  let comment = "";
  let quote: string | undefined;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    const n = line[i + 1];
    if (inBlock) {
      const end = line.indexOf("*/", i);
      if (end < 0) return { code, comment: `${comment} ${line.slice(i)}`.trim(), inBlock: true };
      comment += ` ${line.slice(i, end)}`;
      i = end + 2;
      inBlock = false;
    } else if (quote) {
      if (c === "\\") i += 2;
      else {
        if (c === quote) quote = undefined;
        i += 1;
      }
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
      code += c + c; // the string is gone, its place is kept
      i += 1;
    } else if (c === "/" && n === "/") {
      comment += ` ${line.slice(i + 2)}`;
      break;
    } else if (c === "/" && n === "*") {
      inBlock = true;
      i += 2;
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, comment: comment.trim(), inBlock };
}

/** A comment that says something: at least one word of three letters. «//» or «// x» is not a reason. */
const isReason = (comment: string): boolean => /\p{L}{3,}/u.test(comment);

const MOUSE_CLICK = /\bmouse\s*\.\s*(?:click|dblclick)\s*\(/;
const FORCE = /\bforce\s*:\s*true\b/;
const POSITION = /\.\s*(?:first\s*\(\s*\)|nth\s*\()/;

/**
 * #226: errors in generated code, found before the suite is run. A pointer click at coordinates, a click forced past
 * the actionability checks, and a position picked blindly (`.first()` / `.nth(`) hide a wrong element behind a green
 * test. A position is allowed with a comment on the same line or on the line above that says why the position is the
 * point of the check (sorting, say). Strings and comments are not read as code.
 */
export function lintErrors(suite: GeneratedSuite): LintFinding[] {
  const out: LintFinding[] = [];
  for (const f of suite.files) {
    let inBlock = false;
    let aboveReason = false; // the line above is a comment that says something
    f.content.split("\n").forEach((line, i) => {
      const parts = splitLine(line, inBlock);
      inBlock = parts.inBlock;
      const where = `line ${i + 1}: ${snippet(line)}`;
      if (MOUSE_CLICK.test(parts.code)) {
        out.push({ file: f.path, kind: "mouse-click", detail: `page.mouse.click clicks at coordinates, not at an element — click the element's locator (${where})` });
      }
      if (FORCE.test(parts.code)) {
        out.push({ file: f.path, kind: "force-click", detail: `force: true skips the actionability checks, so it clicks what is hidden or covered — wait for the element instead (${where})` });
      }
      if (POSITION.test(parts.code) && !isReason(parts.comment) && !aboveReason) {
        out.push({
          file: f.path,
          kind: "blind-position",
          detail: `.first() / .nth() picks by position — narrow by context (the row, card or section's name: getByRole('row', { name: /Jane/ }).getByRole('button', { name: 'Delete' })), or add a comment saying why the position is the point of the check (${where})`,
        });
      }
      aboveReason = parts.code.trim() === "" && isReason(parts.comment);
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
