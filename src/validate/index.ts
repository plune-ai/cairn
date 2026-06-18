import { runSpecs, type RawTestResult } from "./runner.js";

export { runSpecs } from "./runner.js";
export type { RawTestResult, TestStatus } from "./runner.js";

export interface TestResult {
  test: string;
  status: "passed" | "failed" | "flaky";
  /** Playwright's failure message for a non-green test (carried into the repair hint). */
  error?: string;
}

export interface ValidationReport {
  results: TestResult[];
  /** Share of consistently green tests (flaky does NOT count as green). */
  greenRatio: number;
  flakyCount: number;
}

/**
 * Classify N runs into pass/fail/flaky (Spike S4): passed = all runs green;
 * failed = none green; flaky = mixed. Flaky does not count as green (does not poison greenRatio).
 */
export function classifyRuns(runs: RawTestResult[][]): ValidationReport {
  const byTitle = new Map<string, string[]>();
  const errByTitle = new Map<string, string>();
  for (const run of runs) {
    for (const t of run) {
      const arr = byTitle.get(t.title) ?? [];
      arr.push(t.status);
      byTitle.set(t.title, arr);
      if (t.error && !errByTitle.has(t.title)) errByTitle.set(t.title, t.error); // first failure message wins
    }
  }

  const results: TestResult[] = [];
  for (const [title, statuses] of byTitle) {
    const passes = statuses.filter((s) => s === "passed").length;
    const status: TestResult["status"] =
      passes === statuses.length ? "passed" : passes === 0 ? "failed" : "flaky";
    const error = errByTitle.get(title);
    // carry the failure message only for non-green tests (a passed test has nothing to repair)
    results.push({ test: title, status, ...(status !== "passed" && error ? { error } : {}) });
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const flakyCount = results.filter((r) => r.status === "flaky").length;
  const greenRatio = results.length > 0 ? passed / results.length : 0;
  return { results, greenRatio, flakyCount };
}

export interface ValidateOptions {
  /** Number of runs for flaky detection (Spike S4; default 2). */
  reruns?: number;
  /** storageState file for authenticated runs (passed to playwright.config). */
  storageStatePath?: string;
  /** Browser channel (chrome/msedge) → run the suite on the system browser (no bundled Chromium). */
  channel?: string;
  /** Parallel Playwright workers (default 5; from cfg.playwrightWorkers / PLAYWRIGHT_WORKERS). */
  workers?: number;
}

/**
 * Run the generated suite (already written to runDir/tests) N times and classify it.
 * ⚠️ runDir must be INSIDE the project (spec files resolve @playwright/test via node_modules).
 */
export async function validateSuite(
  runDir: string,
  opts: ValidateOptions = {},
): Promise<ValidationReport> {
  const reruns = Math.max(1, opts.reruns ?? 2);
  const runs: RawTestResult[][] = [];
  for (let i = 0; i < reruns; i += 1) {
    runs.push(await runSpecs(runDir, { storageStatePath: opts.storageStatePath, channel: opts.channel, workers: opts.workers }));
  }
  return classifyRuns(runs);
}
