import type { ElementRef } from "../browser/types.js";
import type { TestCase } from "../design/index.js";
import type { JourneyCase } from "../design/schema.js";
import type { ValidationReport } from "../validate/index.js";
import type { Score } from "../eval/scorers.js";
import { METRIC_LEGEND, dirGlyph } from "../eval/legend.js";
import type { CostReport } from "../llm/cost.js";

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
  /** Per-role cost + tokens (L1-01); rendered as a table when present. */
  cost?: CostReport;
  /** Per-run LLM-call budget usage (L1-04, Box 3) — rendered as a header bullet when present. */
  budget?: { used: number; max: number };
  /** The repair loop bailed early because it stopped making progress (L1-04, Box 2). */
  stoppedEarly?: boolean;
  /** #59: multi-page journey cases (rendered as a section when present). */
  journeys?: JourneyCase[];
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
  if (r.budget) {
    const remaining = Math.max(0, r.budget.max - r.budget.used);
    lines.push(`- **LLM calls:** ${r.budget.used} / ${r.budget.max} (${remaining} remaining — cost guardrail)`);
  }
  if (r.stoppedEarly) {
    lines.push("- **⚠ Repair:** stopped early — no progress across attempts (best-so-far suite kept)");
  }
  lines.push("");

  if (r.scores && r.scores.length > 0) {
    lines.push(
      "## Metrics (scores)",
      "",
      "↑ higher is better · ↓ lower is better · judge = scored by an LLM, the rest are computed from run data.",
      "",
      "| metric | value | meaning |",
      "|---|---|---|",
    );
    for (const s of r.scores) {
      const meta = METRIC_LEGEND[s.name]; // unknown metric → no glyph, empty meaning (graceful)
      const glyph = dirGlyph(s.name);
      const name = `${s.name}${glyph ? ` ${glyph}` : ""}${meta?.kind === "judge" ? " (judge)" : ""}`;
      const value = `${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""}`;
      lines.push(`| ${name} | ${value} | ${meta?.blurb ?? ""} |`);
    }
    lines.push("");
  }

  if (r.cost && r.cost.perRole.length > 0) {
    lines.push(
      "## Cost (per role)",
      "",
      "| role | model(s) | calls | input tok | output tok | cost (USD) |",
      "|---|---|---|---|---|---|",
    );
    for (const c of r.cost.perRole) {
      const usd = c.costUsd === null ? "—" : `$${c.costUsd.toFixed(4)}`;
      lines.push(`| ${c.role} | ${c.models.join(", ")} | ${c.calls} | ${c.inputTokens} | ${c.outputTokens} | ${usd} |`);
    }
    const total = r.cost.totalCostUsd === null ? "— (some prices unknown)" : `$${r.cost.totalCostUsd.toFixed(4)}`;
    lines.push(`| **total** |  |  |  | ${r.cost.totalTokens} | ${total} |`, "");
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

  // #59: multi-page user journeys (only present on a --flow run).
  if (r.journeys && r.journeys.length > 0) {
    lines.push(`## User journeys (${r.journeys.length}) — multi-page`, "");
    for (const j of r.journeys) {
      lines.push(`### ${j.id} · [${j.priority} · ${j.technique}] ${j.title}`);
      if (j.preconditions.length) lines.push(`- Preconditions: ${j.preconditions.join("; ")}`);
      for (const s of j.steps) {
        const refs = s.elementRefs.length ? ` [refs: ${s.elementRefs.join(", ")}]` : "";
        lines.push(`- (${s.page}) ${s.action}${refs}`);
      }
      lines.push(`- ⇒ ${j.expected}`, "");
    }
  }
  return lines.join("\n");
}
