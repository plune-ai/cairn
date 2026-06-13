import type { RunWriter } from "../artifacts/index.js";
import type { CostReport } from "../llm/cost.js";
import { classifyRunError, renderRunSummary, partialReportPayload, type BudgetReport } from "./summary.js";

export interface FailureContext {
  runId: string;
  url: string;
  error: unknown;
  cost?: CostReport;
  budget?: BudgetReport;
  sessionName?: string;
  onProgress?: (event: string) => void;
}

/** Run a best-effort artifact write — an artifact write must never mask the original failure. */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // swallow — the run already failed; we just want to leave whatever trail we can.
  }
}

/**
 * The single failure path for `runExploration` (L1-04, Box 1/3/4): classify the error into a
 * readable, actionable message, write partial artifacts (report.json/report.md/run.log), and return
 * the friendly Error to throw. The user always gets a summary + a partial report on disk — never a
 * raw traceback, and never a silent halt.
 */
export async function finalizeFailure(runWriter: RunWriter, ctx: FailureContext): Promise<Error> {
  const info = classifyRunError(ctx.error, { sessionName: ctx.sessionName, runDir: runWriter.dir });
  ctx.onProgress?.(info.line);

  const summary = renderRunSummary({
    runDir: runWriter.dir,
    cost: ctx.cost,
    budget: ctx.budget,
    partial: true,
    note: info.hint,
  });

  await safe(() =>
    runWriter.writeReport(
      partialReportPayload({ runId: ctx.runId, url: ctx.url, error: info.line, cost: ctx.cost, budget: ctx.budget }),
    ),
  );
  await safe(() =>
    runWriter.writeReportMd(
      [
        "# QA Explorer — run report (partial)",
        "",
        `- **URL:** ${ctx.url}`,
        `- **Run ID:** ${ctx.runId}`,
        "",
        `> ⚠ ${info.line}`,
        `> ${info.hint}`,
        "",
        ...summary,
      ].join("\n"),
    ),
  );
  await safe(() => runWriter.writeLog([info.line, "", ...summary].join("\n")));

  return new Error([info.line, "", ...summary, "", info.hint].join("\n"));
}
