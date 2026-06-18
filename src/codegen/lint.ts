import type { GeneratedSuite } from "./schema.js";

export interface LintFinding {
  file: string;
  kind: "fragile-locator" | "prefer-role" | "bad-wait";
  detail: string;
}

// CSS/XPath/positional locators — fragile vs role+name (high severity).
const CSS_OR_XPATH = /\.locator\(|page\.\$\(|xpath=|>>|:nth-/;
// test-id — acceptable fallback but role+name is preferred (mid severity).
const TEST_ID = /getByTestId\(/;
// fixed sleeps + networkidle — flaky vs web-first auto-retrying assertions (high severity).
const BAD_WAIT = /waitForTimeout\(|networkidle/;

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

/** Deterministic anti-pattern scan of generated specs (no I/O, never throws). Source of truth for "fragile". */
export function lintSuite(suite: GeneratedSuite): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const f of suite.files) {
    for (const line of f.content.split("\n")) findings.push(...scanLine(f.path, line));
  }
  return findings;
}

/** Format findings as a repair-hint block. Empty string when clean → a no-op when appended to a hint. */
export function lintHint(findings: LintFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((x) => `- [${x.kind}] ${x.file}: ${x.detail}`);
  return `Flaky-hardening — fix these fragile patterns:\n${lines.join("\n")}`;
}
