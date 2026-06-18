/**
 * TUI-only view models. Intentionally NOT exported from the package (src/index.ts) —
 * the TUI is a private application layer over the public API.
 */
import type { ExploreResult, DesignResult, AutomateResult } from "../index.js";

/** The four runnable commands the launcher offers. */
export type Command = "explore" | "design" | "automate" | "observe";

/** Any terminal result the SummaryScreen may render. */
export type AnyResult = ExploreResult | DesignResult | AutomateResult;

export type PlanningStyle = "happy" | "negative" | "coverage" | "all";

/** Values collected by FormScreen before a run. `config` is added later by useRunner. */
export interface FormValues {
  url: string;
  session?: string;
  sessionFile?: string;
  checklist?: string;
  style: PlanningStyle;
  headed: boolean;
  // Browser/LLM config — parity with the CLI flags --backend/--channel/--routing.
  // undefined = leave the env/default untouched (resolveConfig only overrides a SET flag).
  backend?: "lib" | "cli";
  channel?: string;
  routing?: string;
  // automate-only:
  runDir?: string;
  validate?: boolean;
}

/** One past run, summarized from runs/<id>/report.json for the RunsListScreen. */
export interface RunSummary {
  runId: string;
  dir: string;
  url: string;
  mode: "explore" | "design";
  greenRatio?: number;
  pilot?: "pass" | "needs-work" | "fail";
  testCaseCount: number;
  date: Date;
}

/** Live status of one graph node on the dashboard checklist. */
export interface NodeStatus {
  node: string;
  state: "pending" | "running" | "done";
}
