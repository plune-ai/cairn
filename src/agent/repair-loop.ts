import type { GeneratedSuite } from "../codegen/index.js";
import type { ValidationReport } from "../validate/index.js";
import type { TriageResult } from "../decider/uses/repair-triage.js";
import type { HealRecord } from "../decider/uses/locator-heal.js";
import { progressSnapshot, madeProgress } from "./progress.js";

/** Clip a failure message so the repair hint stays compact (the cause is in the first lines). */
const clip = (s: string, n = 500): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Build the repair hint from the failing tests: each name + WHY it failed (the Playwright error —
 * e.g. a strict-mode "resolved to N elements"). Feeding the cause, not just the name, is what lets
 * codegen actually fix it (add exact:true/.first()). Shared by the automate loop and the explore graph.
 */
export function failedTestsHint(
  results: ValidationReport["results"],
  triage?: ReadonlyMap<string, TriageResult>,
  heals?: ReadonlyMap<string, HealRecord>,
): string {
  return results
    .filter((r) => r.status !== "passed" && !triage?.get(r.test)?.exclude)
    .map((r) => {
      // ADR-0022: a confident triage category travels with the test as a hint; absent → today's line.
      const t = triage?.get(r.test);
      const name = t ? `${r.test} [triage: ${t.category}]` : r.test;
      const line = r.error ? `- ${name}: ${clip(r.error.trim())}` : `- ${name}`;
      // locator-heal: a proposal, not a patch — the repair still writes the code, and the next validation judges it.
      const h = heals?.get(r.test);
      return h ? `${line}\n  → replace ${h.from} with ${h.to} (verified: 1 match)` : line;
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
   * keeps the test out of the hint while it keeps failing that way; absent → the loop is exactly what it was.
   */
  triage?: (failed: ValidationReport["results"]) => Promise<TriageResult[]>;
  /**
   * Optional (ADR-0022 locator-heal): a replacement for the locator a failure triage called a locator failure,
   * verified on the page. Asked once per failure, one failure at a time (one browser page); absent → no change.
   */
  heal?: (failure: ValidationReport["results"][number], verdict: TriageResult) => Promise<HealRecord | undefined>;
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
  /** Locator replacements proposed in the hint the kept suite was generated from. Absent when none. */
  healed?: HealRecord[];
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
  // ADR-0022: a verdict holds while the test fails THE SAME WAY. Every repair regenerates the whole suite, so a
  // test can pass, or fail for another reason — then it is asked about again. Keyed by test + error, and each
  // failure is asked ONCE whatever came back: a confident verdict is kept, a doubt or a fallback leaves it to repair.
  const asked = new Set<string>();
  const verdicts = new Map<string, TriageResult>();
  const excludedTests = new Set<string>();
  const failure = (r: ValidationReport["results"][number]): string => `${r.test}\n${r.error ?? ""}`;
  const failingIn = (v: ValidationReport): ValidationReport["results"] => v.results.filter((r) => r.status !== "passed");
  const verdictsFor = (failing: ValidationReport["results"]): TriageResult[] => failing.flatMap((r) => verdicts.get(failure(r)) ?? []);
  // locator-heal: one proposal per failure, asked once like a verdict (undefined = asked, nothing proposed). Every
  // repair regenerates the whole suite from its own hint, so only the kept suite's hint says what it was offered.
  const proposals = new Map<string, HealRecord | undefined>();
  let bestHealed: HealRecord[] = [];
  /** Ask about the failures not asked yet and remember the confident verdicts; returns the new exclusions. */
  const ask = async (failing: ValidationReport["results"]): Promise<TriageResult[]> => {
    const fresh = failing.filter((r) => !asked.has(failure(r)));
    if (!deps.triage || fresh.length === 0) return [];
    for (const r of fresh) asked.add(failure(r));
    const answered = await deps.triage(fresh);
    for (const t of answered) {
      const r = fresh.find((f) => f.test === t.test);
      if (r) verdicts.set(failure(r), t);
      if (t.exclude) excludedTests.add(t.test);
    }
    return answered.filter((t) => t.exclude);
  };

  while (bestGreen < 1 && attempts < deps.maxRepair) {
    let triage: Map<string, TriageResult> | undefined;
    let heals: Map<string, HealRecord> | undefined;
    if (deps.triage) {
      const failing = failingIn(validation);
      const newlyExcluded = await ask(failing);
      if (newlyExcluded.length > 0) {
        const names = newlyExcluded.map((t) => `${t.test} (${t.category})`).join(", ");
        deps.onProgress?.(`repair — triage: left out of repair as a likely app bug / broken environment: ${names}`);
      }
      const known = verdictsFor(failing);
      if (failing.length > 0 && known.filter((t) => t.exclude).length === failing.length) {
        deps.onProgress?.(`repair — skipped: all ${failing.length} failing test(s) look like an app bug or a broken environment.`);
        break; // before attempts += 1: nothing is left that repairing the code could fix
      }
      triage = new Map(known.map((t) => [t.test, t] as const));
      if (deps.heal) {
        heals = new Map();
        for (const r of failing) {
          const t = verdicts.get(failure(r));
          if (!t) continue;
          if (!proposals.has(failure(r))) proposals.set(failure(r), await deps.heal(r, t)); // one at a time: one page
          const h = proposals.get(failure(r));
          if (h) heals.set(r.test, h);
        }
        if (heals.size > 0) deps.onProgress?.(`repair — locator-heal: a verified replacement for ${heals.size} test(s) goes into the hint`);
      }
    }
    attempts += 1;
    const failed = failedTestsHint(validation.results, triage, heals);
    const lintFindings = deps.lint?.(suite) ?? ""; // lint the suite that produced this failing validation
    const hint = [failed, lintFindings].filter(Boolean).join("\n");
    deps.onProgress?.(`repair — attempt ${attempts}`);
    suite = await deps.generate(hint);
    validation = await deps.validate();

    if (validation.results.length > 0 && validation.greenRatio > bestGreen) {
      bestSuite = suite;
      bestValidation = validation;
      bestGreen = validation.greenRatio;
      bestHealed = [...(heals?.values() ?? [])];
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

  // The kept suite can be the last validation, which no loop head triaged: a test excluded earlier that still fails
  // there — its error reworded by the regenerated suite — is asked once more, so it does not drop out of the report.
  // A failure asked before is never asked again: a test that went into repair on a doubt is not reported as excluded.
  await ask(failingIn(bestValidation).filter((r) => excludedTests.has(r.test)));
  // Not repaired = the KEPT suite's failures that a confident triage excluded — a test that passed is not listed.
  const notRepaired = verdictsFor(failingIn(bestValidation)).filter((t) => t.exclude);
  return {
    bestSuite,
    bestValidation,
    attempts,
    stoppedEarly,
    ...(notRepaired.length ? { notRepaired } : {}),
    ...(bestHealed.length ? { healed: bestHealed } : {}),
  };
}
