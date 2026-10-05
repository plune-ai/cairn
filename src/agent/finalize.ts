import type { RunWriter } from "../artifacts/index.js";
import type { CostReport } from "../llm/cost.js";
import { classifyRunError, renderRunSummary, partialReportPayload, type BudgetReport } from "./summary.js";
import type { RunMode } from "../artifacts/contract.js";

export interface FailureContext {
  runId: string;
  url: string;
  /** Which kind of run this was, so the partial artifact says so too. A reader should never have to
   * infer the kind of a run from whichever keys a FAILURE happened to leave behind. */
  mode?: RunMode;
  error: unknown;
  cost?: CostReport;
  budget?: BudgetReport;
  sessionName?: string;
  onProgress?: (event: string) => void;
  /** The progress lines the run has already buffered for run.log. Required: left out, they would be replaced by the
   * summary alone. The run's `onProgress` must append every event to this same buffer, the failure line included
   * (`finalizeFailure` reports it through `onProgress`), so the log written here is these lines, then the summary,
   * as a finished run's log is. */
  logLines: readonly string[];
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
      partialReportPayload({
        runId: ctx.runId,
        url: ctx.url,
        mode: ctx.mode,
        error: info.line,
        errorDetail: info.detail,
        cost: ctx.cost,
        budget: ctx.budget,
      }),
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
  // The failure line is already in the buffer: `onProgress` above is the run's own, which appends it. With nothing
  // buffered the log is the failure line and the summary.
  const progress = ctx.logLines.length ? ctx.logLines : [info.line];
  await safe(() => runWriter.writeLog([...progress, "", ...summary].join("\n")));

  return new Error([info.line, "", ...summary, "", info.hint].join("\n"));
}
