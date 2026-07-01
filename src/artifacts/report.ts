import type { ElementRef } from "../browser/types.js";
import type { TestCase } from "../design/index.js";
import type { JourneyCase } from "../design/schema.js";
import type { CoverageReport } from "../eval/coverage.js";
import type { ValidationReport } from "../validate/index.js";
import type { Score } from "../eval/scorers.js";
import { METRIC_LEGEND, dirGlyph } from "../eval/legend.js";
import type { CostReport } from "../llm/cost.js";
import type { ApiCaseResult } from "../api/runner.js";
import type { ApiCoverageReport } from "../api/coverage.js";
import type { ApiScenarioResult } from "../api/scenario-runner.js";
import { displayPath } from "../agent/summary.js";

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
  /** #61: coverage view (covered vs observed-but-untested surface). */
  coverage?: CoverageReport;
  /** #61: suggested gap cases (--gaps) — rendered as clearly-marked suggestions. */
  gapCases?: TestCase[];
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

  // #61: coverage gap-analysis — covered vs observed-but-untested, grouped by page.
  if (r.coverage) {
    const c = r.coverage;
    lines.push(`## Coverage (${c.covered}/${c.observed} interactive elements — ${Math.round(c.ratio * 100)}%)`, "");
    if (c.untestedEdges.length > 0) {
      lines.push(`- **Untested transitions:** ${c.untestedEdges.length}`);
      for (const e of c.untestedEdges) lines.push(`  - ${e.from} → ${e.to} (via ${e.via.role} "${e.via.name ?? ""}")`);
      lines.push("");
    }
    for (const p of c.byPage) {
      if (p.gaps.length === 0) continue;
      lines.push(`### Untested on ${p.url} (${p.covered}/${p.observed} covered)`, "");
      lines.push("| ref | role | name | why it matters |", "|---|---|---|---|");
      for (const g of p.gaps) lines.push(`| ${g.ref} | ${g.role} | ${g.name ?? ""} | ${g.why} |`);
      lines.push("");
    }
  }

  // #61: suggested cases to close the top gaps (only with --gaps) — clearly marked as suggestions.
  if (r.gapCases && r.gapCases.length > 0) {
    lines.push(`## Suggested gap cases (${r.gapCases.length}) — SUGGESTIONS, review before adopting`, "");
    for (const tc of r.gapCases) {
      lines.push(`### ${tc.id} · [${tc.priority} · ${tc.technique}] ${tc.title}`);
      for (const s of tc.steps) lines.push(`- ${s}`);
      lines.push(`- ⇒ ${tc.expected}`);
      if (tc.elementRefs.length) lines.push(`- refs: ${tc.elementRefs.join(", ")}`);
      lines.push("");
    }
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

/** C1-04 / API-4 (#134): `cairn api` run report — sibling of {@link renderReportMd} for the api modality. */
export interface ApiReportInput {
  runId: string;
  /** The base URL the cases were run against. */
  baseUrl: string;
  /** The OpenAPI spec source (path or URL). */
  source: string;
  results: ApiCaseResult[];
  /** Endpoints in the ingested spec covered by the run. */
  endpointCount: number;
  evidencePath: string;
  /** API-6 (#136): spec-vs-tested coverage (playswag-style) — rendered as a gaps section when present. */
  coverage?: ApiCoverageReport;
  /** API-9 (#146): multi-endpoint scenario chains — rendered as a section only when non-empty. */
  scenarios?: ApiScenarioResult[];
}

/** Human-readable Markdown run report for `cairn api`: per-operation pass/fail + evidence link. */
export function renderApiReportMd(r: ApiReportInput): string {
  const passed = r.results.filter((x) => x.passed).length;
  const lines: string[] = ["# QA Explorer — API run report", ""];
  lines.push(`- **Base URL:** ${r.baseUrl}`);
  lines.push(`- **Spec:** ${r.source}`);
  lines.push(`- **Run ID:** ${r.runId}`);
  lines.push(`- **Operations:** ${passed}/${r.results.length} passed · ${r.endpointCount} endpoint(s) covered`);
  lines.push(`- **Evidence:** ${displayPath(r.evidencePath)}`);
  lines.push("");

  lines.push(`## Operations (${r.results.length})`, "");
  lines.push("| status | method | url | expected | got |", "|---|---|---|---|---|");
  for (const x of r.results) {
    const got = x.error ? `error: ${x.error}` : String(x.response?.status ?? "—");
    lines.push(`| ${x.passed ? "✓" : "✗"} | ${x.method} | ${x.url} | ${x.expectedStatus} | ${got} |`);
  }
  lines.push("");

  // API-9 (#146): per-scenario pass/fail, each step's own row (mirrors the Operations table above).
  if (r.scenarios && r.scenarios.length > 0) {
    const scenariosPassed = r.scenarios.filter((s) => s.passed).length;
    lines.push(`## Scenarios (${scenariosPassed}/${r.scenarios.length} passed)`, "");
    for (const s of r.scenarios) {
      lines.push(`### ${s.passed ? "✓" : "✗"} ${s.name}`, "");
      lines.push("| status | method | url | expected | got |", "|---|---|---|---|---|");
      for (const step of s.steps) {
        const got = step.error ? step.error : String(step.response?.status ?? "—");
        lines.push(`| ${step.passed ? "✓" : "✗"} | ${step.method} | ${step.url || "—"} | ${step.expectedStatus} | ${got} |`);
      }
      lines.push("");
    }
  }

  // API-6 (#136): spec-vs-tested coverage (playswag-style) — gaps only; covered ops need no row.
  if (r.coverage) {
    const c = r.coverage;
    lines.push(`## Coverage (${c.coveredCount}/${c.endpointCount} endpoint(s) — ${Math.round(c.ratio * 100)}%)`, "");
    const gaps = c.endpoints.filter((e) => e.status !== "covered");
    if (gaps.length > 0) {
      lines.push("| status | method | path | operationId | tested | missing |", "|---|---|---|---|---|---|");
      for (const e of gaps) {
        const missing = e.declaredStatuses.filter((s) => !e.testedStatuses.includes(s)).join(", ");
        const dep = e.deprecated ? " (deprecated)" : "";
        lines.push(
          `| ${e.status === "partial" ? "⚠ partial" : "✗ uncovered"} | ${e.method} | ${e.path}${dep} | ${e.operationId ?? ""} | ${e.testedStatuses.join(", ") || "—"} | ${missing} |`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
