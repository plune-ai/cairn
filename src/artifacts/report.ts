import type { ElementRef } from "../browser/types.js";
import type { TestCase } from "../design/index.js";
import type { ValidationReport } from "../validate/index.js";
import type { Score } from "../eval/scorers.js";

/** Generate a Playwright locator for an element (ref → getByRole). */
export function locatorFor(el: ElementRef): string {
  const name = el.name ? `, { name: '${el.name.replace(/'/g, "\\'")}' }` : "";
  return `page.getByRole('${el.role}'${name})`;
}

export interface ReportInput {
  runId: string;
  url: string;
  backend: string;
  profile: string;
  pageSemantics: string;
  elements: ElementRef[];
  testCases: TestCase[];
  validation?: ValidationReport;
  scores?: Score[];
  consoleErrors?: string[];
}

function mark(status: string): string {
  return status === "passed" ? "✓" : status === "flaky" ? "~" : "✗";
}

/** Human-readable Markdown run report: semantics, elements+selectors, cases, validation. */
export function renderReportMd(r: ReportInput): string {
  const lines: string[] = ["# QA Explorer — run report", ""];
  lines.push(`- **URL:** ${r.url}`);
  lines.push(`- **Run ID:** ${r.runId}`);
  lines.push(`- **Backend:** ${r.backend} · **Profile:** ${r.profile}`);
  lines.push(`- **Purpose:** ${r.pageSemantics}`);
  if (r.validation) {
    lines.push(
      `- **Validation:** ${Math.round(r.validation.greenRatio * 100)}% green (flaky: ${r.validation.flakyCount})`,
    );
  }
  lines.push("");

  if (r.scores && r.scores.length > 0) {
    lines.push("## Metrics (scores)", "", "| metric | value |", "|---|---|");
    for (const s of r.scores) {
      lines.push(`| ${s.name} | ${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""} |`);
    }
    lines.push("");
  }

  if (r.consoleErrors && r.consoleErrors.length > 0) {
    lines.push(`## Page JS errors (${r.consoleErrors.length})`, "");
    for (const e of r.consoleErrors.slice(0, 20)) lines.push(`- ${e}`);
    lines.push("");
  }

  const interactive = r.elements.filter((e) => e.interactive);
  lines.push(`## Interactive elements (${interactive.length})`, "");
  lines.push("| ref | role | name | Playwright locator |", "|---|---|---|---|");
  for (const e of interactive) {
    lines.push(`| ${e.ref} | ${e.role} | ${e.name ?? ""} | \`${locatorFor(e)}\` |`);
  }
  lines.push("");

  lines.push(`## Test cases (${r.testCases.length})`, "");
  const statusByTitle = new Map((r.validation?.results ?? []).map((x) => [x.test, x.status]));
  for (const tc of r.testCases) {
    const st = statusByTitle.get(tc.title);
    lines.push(`### ${tc.id} · [${tc.priority} · ${tc.technique}] ${tc.title}${st ? ` — ${mark(st)}` : ""}`);
    if (tc.preconditions.length) lines.push(`- Preconditions: ${tc.preconditions.join("; ")}`);
    for (const s of tc.steps) lines.push(`- ${s}`);
    lines.push(`- ⇒ ${tc.expected}`);
    if (tc.elementRefs.length) lines.push(`- refs: ${tc.elementRefs.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
