import type { GeneratedSuite } from "../codegen/index.js";
import type { ValidationReport } from "../validate/index.js";
import { progressSnapshot, madeProgress } from "./progress.js";

/** Clip a failure message so the repair hint stays compact (the cause is in the first lines). */
const clip = (s: string, n = 500): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Build the repair hint from the failing tests: each name + WHY it failed (the Playwright error —
 * e.g. a strict-mode "resolved to N elements"). Feeding the cause, not just the name, is what lets
 * codegen actually fix it (add exact:true/.first()). Shared by the automate loop and the explore graph.
 */
export function failedTestsHint(results: ValidationReport["results"]): string {
  return results
    .filter((r) => r.status !== "passed")
    .map((r) => (r.error ? `- ${r.test}: ${clip(r.error.trim())}` : `- ${r.test}`))
    .join("\n");
}

export interface RepairLoopDeps {
  /** Produce AND write a suite (so `validate` can run it). `repairHint` = failing test names on a repair pass. */
  generate: (repairHint?: string) => Promise<GeneratedSuite>;
  /** Run the written suite and classify it. */
  validate: () => Promise<ValidationReport>;
  /** Max repair attempts after the initial generation. */
  maxRepair: number;
  onProgress?: (event: string) => void;
}

export interface RepairLoopResult {
  bestSuite: GeneratedSuite;
  bestValidation: ValidationReport;
  /** Repair attempts actually run (0 = green on the first try, or maxRepair=0). */
  attempts: number;
  /** Stopped before maxRepair because an attempt made no progress (Box 2). */
  stoppedEarly: boolean;
}

/**
 * Shared validate ⇄ repair ⇄ keep-best loop with no-progress early-stop (L1-04, #40). The same
 * convergence logic the explore graph uses, factored so the decoupled `automate` flow repairs too.
 * Pure orchestration over injected `generate`/`validate` — unit-testable without a browser or LLM.
 */
export async function runRepairLoop(deps: RepairLoopDeps): Promise<RepairLoopResult> {
  let suite = await deps.generate();
  let validation = await deps.validate();

  // keep-best: only accept a regeneration that is BETTER and not broken (≥1 test).
  let bestSuite = suite;
  let bestValidation = validation;
  let bestGreen = validation.results.length > 0 ? validation.greenRatio : -1;
  let prevSnapshot = progressSnapshot(validation);
  let attempts = 0;
  let stoppedEarly = false;

  while (bestGreen < 1 && attempts < deps.maxRepair) {
    attempts += 1;
    const failed = failedTestsHint(validation.results);
    deps.onProgress?.(`repair — attempt ${attempts}`);
    suite = await deps.generate(failed);
    validation = await deps.validate();

    if (validation.results.length > 0 && validation.greenRatio > bestGreen) {
      bestSuite = suite;
      bestValidation = validation;
      bestGreen = validation.greenRatio;
    }

    // No-progress detection (Box 2): same green ratio AND the same failing tests → bail early.
    const snap = progressSnapshot(validation);
    if (!madeProgress(prevSnapshot, snap)) {
      stoppedEarly = true;
      deps.onProgress?.("repair — stopped early: no progress vs the previous attempt (same failing tests).");
      break;
    }
    prevSnapshot = snap;
  }

  return { bestSuite, bestValidation, attempts, stoppedEarly };
}
