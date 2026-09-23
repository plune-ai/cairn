import type { GeneratedSuite } from "../codegen/index.js";
import type { ValidationReport } from "../validate/index.js";
import type { TriageResult } from "../decider/uses/repair-triage.js";
import { progressSnapshot, madeProgress } from "./progress.js";

/** Clip a failure message so the repair hint stays compact (the cause is in the first lines). */
const clip = (s: string, n = 500): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Build the repair hint from the failing tests: each name + WHY it failed (the Playwright error —
 * e.g. a strict-mode "resolved to N elements"). Feeding the cause, not just the name, is what lets
 * codegen actually fix it (add exact:true/.first()). Shared by the automate loop and the explore graph.
 */
export function failedTestsHint(results: ValidationReport["results"], triage?: ReadonlyMap<string, TriageResult>): string {
  return results
    .filter((r) => r.status !== "passed" && !triage?.get(r.test)?.exclude)
    .map((r) => {
      // ADR-0022: a confident triage category travels with the test as a hint; absent → today's line.
      const t = triage?.get(r.test);
      const name = t ? `${r.test} [triage: ${t.category}]` : r.test;
      return r.error ? `- ${name}: ${clip(r.error.trim())}` : `- ${name}`;
    })
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
  /** Optional: extra repair guidance from linting the FAILED suite (flaky-hardening, #57). Absent → no-op. */
  lint?: (suite: GeneratedSuite) => string;
  /**
   * Optional (ADR-0022 repair-triage): classify failing tests. A confident app-bug / env-or-session answer
   * keeps the test out of the hint for the rest of the loop; absent → the loop is exactly what it was.
   */
  triage?: (failed: ValidationReport["results"]) => Promise<TriageResult[]>;
}

export interface RepairLoopResult {
  bestSuite: GeneratedSuite;
  bestValidation: ValidationReport;
  /** Repair attempts actually run (0 = green on the first try, or maxRepair=0). */
  attempts: number;
  /** Stopped before maxRepair because an attempt made no progress (Box 2). */
  stoppedEarly: boolean;
  /** Tests triage kept out of repair (likely an app bug or a broken environment). Absent when none. */
  notRepaired?: TriageResult[];
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
  const excluded = new Map<string, TriageResult>(); // a test excluded once stays excluded (no second call)

  while (bestGreen < 1 && attempts < deps.maxRepair) {
    let triage: Map<string, TriageResult> | undefined;
    if (deps.triage) {
      const failing = validation.results.filter((r) => r.status !== "passed");
      const fresh = await deps.triage(failing.filter((r) => !excluded.has(r.test)));
      const newlyExcluded = fresh.filter((t) => t.exclude);
      for (const t of newlyExcluded) excluded.set(t.test, t);
      if (newlyExcluded.length > 0) {
        const names = newlyExcluded.map((t) => `${t.test} (${t.category})`).join(", ");
        deps.onProgress?.(`repair — triage: left out of repair as a likely app bug / broken environment: ${names}`);
      }
      if (failing.length > 0 && failing.every((r) => excluded.has(r.test))) {
        deps.onProgress?.(`repair — skipped: all ${failing.length} failing test(s) look like an app bug or a broken environment.`);
        break; // before attempts += 1: nothing is left that repairing the code could fix
      }
      triage = new Map([...excluded, ...fresh.map((t) => [t.test, t] as const)]);
    }
    attempts += 1;
    const failed = failedTestsHint(validation.results, triage);
    const lintFindings = deps.lint?.(suite) ?? ""; // lint the suite that produced this failing validation
    const hint = [failed, lintFindings].filter(Boolean).join("\n");
    deps.onProgress?.(`repair — attempt ${attempts}`);
    suite = await deps.generate(hint);
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

  return { bestSuite, bestValidation, attempts, stoppedEarly, ...(excluded.size ? { notRepaired: [...excluded.values()] } : {}) };
}
