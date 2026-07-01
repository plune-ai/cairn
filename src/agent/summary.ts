import { join } from "node:path";
import type { ValidationReport } from "../validate/index.js";
import type { CostReport } from "../llm/cost.js";

/**
 * Normalize a path for DISPLAY (console/report) to forward slashes. `resolve()`/`join()` produce
 * `\` on Windows, so a printed `runs\<id>` differs from the `runs/<id>` a mac/linux user sees and is
 * awkward to copy-paste back into a command. Forward slashes are valid on all three platforms.
 * Display-only — never use this to build a path that hits the filesystem.
 */
export function displayPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** What of the per-run LLM-call budget was consumed (L1-04, Box 3). */
export interface BudgetReport {
  used: number;
  max: number;
}

/** C1-04 / API-4 (#134): `cairn api` run counters, rendered alongside web-run validation. */
export interface ApiRunSummary {
  passed: number;
  total: number;
  /** Endpoints in the ingested spec covered by the run (API-1's endpoint count). */
  endpointCount: number;
  /** Where the per-case request/response evidence was written. */
  evidencePath: string;
}

export interface RunSummaryInput {
  /** Where the artifacts landed (runs/<id>). */
  runDir: string;
  validation?: ValidationReport;
  cost?: CostReport;
  budget?: BudgetReport;
  testCaseCount?: number;
  /** The repair loop bailed early because it stopped making progress (Box 2). */
  stoppedEarly?: boolean;
  /** The run ended on a failure path → only partial artifacts were produced (Box 1/3). */
  partial?: boolean;
  /** A free-form note (e.g. the degrade reason) appended to the summary. */
  note?: string;
  /** `cairn api` run counters (API-4) — mutually exclusive with `validation` (web runs). */
  api?: ApiRunSummary;
}

/** 80% of the budget → warn the user the run is close to the cost guardrail. */
const BUDGET_WARN_RATIO = 0.8;

/**
 * Render the final, non-maintainer-friendly run summary as lines (L1-04, Box 4):
 * pass/fail counts, per-role cost+tokens (#6), CallBudget used, and the artifact path.
 * Pure — shared by the CLI, the library, and the failure path.
 */
export function renderRunSummary(s: RunSummaryInput): string[] {
  const lines: string[] = [s.partial ? "=== Run summary (partial) ===" : "=== Run summary ==="];

  if (s.validation) {
    const r = s.validation.results;
    const passed = r.filter((x) => x.status === "passed").length;
    const failed = r.filter((x) => x.status === "failed").length;
    const flaky = r.filter((x) => x.status === "flaky").length;
    const green = Math.round(s.validation.greenRatio * 100);
    lines.push(`  Tests:     ${passed} passed · ${failed} failed · ${flaky} flaky (${green}% green)`);
    // #94 (BORROW-05): point the reviewer at the per-scenario screencasts (.webm + step chapters).
    const casts = s.validation.screencasts;
    if (casts && casts.length > 0) {
      lines.push(`  Screencasts: ${casts.length} .webm recorded → ${displayPath(join(s.runDir, "screencasts"))}/`);
    }
  }
  if (s.api) {
    lines.push(`  Operations: ${s.api.passed}/${s.api.total} passed · ${s.api.endpointCount} endpoint(s) covered`);
    lines.push(`  Evidence:  ${displayPath(s.api.evidencePath)}`);
  }
  if (typeof s.testCaseCount === "number") lines.push(`  Test cases: ${s.testCaseCount}`);

  if (s.budget) {
    const remaining = Math.max(0, s.budget.max - s.budget.used);
    lines.push(`  LLM calls: ${s.budget.used} / ${s.budget.max} used · ${remaining} remaining`);
    if (!s.partial && s.budget.max > 0 && s.budget.used / s.budget.max >= BUDGET_WARN_RATIO) {
      lines.push("  ⚠ approaching the LLM-call budget (cost guardrail)");
    }
  }
  if (s.cost) {
    const usd = s.cost.totalCostUsd === null ? "$— (some prices unknown)" : `$${s.cost.totalCostUsd.toFixed(4)}`;
    lines.push(`  Cost:      ${s.cost.totalTokens} tokens · ${usd}`);
  }
  if (s.stoppedEarly) lines.push("  ⚠ stopped early: no progress across repair attempts");
  if (s.note) lines.push(`  ${s.note}`);
  lines.push(`  Artifacts: ${displayPath(s.runDir)}`);
  return lines;
}

export type RunErrorKind = "navigation" | "session" | "budget" | "config" | "unknown";

export interface RunErrorInfo {
  kind: RunErrorKind;
  /** A one-line, user-facing description (keeps the keyword so the TUI classifier still matches). */
  line: string;
  /** An actionable next step (e.g. where the partial results were saved). */
  hint: string;
}

/**
 * Classify a thrown run error into a friendly {kind, line, hint} (L1-04, Box 1/3) so the user
 * sees a readable message + actionable next step instead of a raw stack trace.
 */
export function classifyRunError(
  err: unknown,
  ctx: { sessionName?: string; runDir?: string } = {},
): RunErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const first = (raw.split(/\r?\n/)[0] ?? "").trim();
  const m = first.toLowerCase();
  const where = ctx.runDir ? ` Partial results saved to ${displayPath(ctx.runDir)}.` : "";

  if (m.includes("budget") || m.includes("call cap") || m.includes("callbudget")) {
    return {
      kind: "budget",
      line: "Call budget reached — the run hit the cost guardrail and stopped early.",
      hint: `Increase maxLlmCalls if this is expected, or check for a loop.${where}`,
    };
  }
  if (
    m.includes("storagestate") ||
    m.includes("session") ||
    m.includes("expired") ||
    m.includes("login") ||
    m.includes("sign in")
  ) {
    return {
      kind: "session",
      line: "The login session looks expired or missing.",
      hint: `Re-capture it: cairn session capture --url <loginUrl>${ctx.sessionName ? ` --name ${ctx.sessionName}` : ""}.${where}`,
    };
  }
  if (
    m.includes("api key") ||
    m.includes("api_key") ||
    m.includes("apikey") ||
    (m.includes("anthropic") && m.includes("required")) ||
    (m.includes("openrouter") && m.includes("required"))
  ) {
    return {
      kind: "config",
      line: "An API key looks missing or invalid.",
      hint: `Set ANTHROPIC_API_KEY / OPENROUTER_API_KEY in your environment.${where}`,
    };
  }
  if (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("navigation") ||
    m.includes("net::err") ||
    m.includes("could not load") ||
    m.includes("could not reach") ||
    m.includes("page.goto") ||
    m.includes("err_name_not_resolved")
  ) {
    return {
      kind: "navigation",
      line: first.startsWith("Could not") ? first : "Could not load the page (navigation failed or timed out).",
      hint: `Check the URL is correct and reachable, then try again.${where}`,
    };
  }
  return { kind: "unknown", line: first || "The run failed.", hint: `See the message above.${where}` };
}

export interface PartialReportInput {
  runId: string;
  url: string;
  error: string;
  cost?: CostReport;
  budget?: BudgetReport;
}

/** Build the report.json payload for a failed/partial run (L1-04, Box 1/3). Pure. */
export function partialReportPayload(i: PartialReportInput): Record<string, unknown> {
  return {
    runId: i.runId,
    url: i.url,
    partial: true,
    error: i.error,
    ...(i.cost ? { cost: i.cost } : {}),
    ...(i.budget ? { budget: i.budget } : {}),
  };
}
