import type { ValidationReport } from "../validate/index.js";

/**
 * A comparable snapshot of one validate attempt — the seam for no-progress detection (L1-04, Box 2).
 * Pure and unit-testable: the repair loop compares consecutive snapshots to decide whether to keep going.
 */
export interface ProgressSnapshot {
  /** Share of consistently-green tests in this attempt. */
  greenRatio: number;
  /** Sorted, joined names of the non-passing tests — the "failure signature". */
  failSignature: string;
}

/** Build a {@link ProgressSnapshot} from a validation report (or zero/empty when there is none). */
export function progressSnapshot(v: ValidationReport | undefined): ProgressSnapshot {
  if (!v) return { greenRatio: 0, failSignature: "" };
  const failing = v.results
    .filter((r) => r.status !== "passed")
    .map((r) => r.test)
    .sort();
  return { greenRatio: v.greenRatio, failSignature: failing.join("|") };
}

/**
 * Did a repair attempt make progress over the previous one?
 * Progress = a higher green ratio OR a different set of failing tests (the repair changed *something*).
 * No progress = the same green ratio AND an identical failure signature → the loop is stuck and should
 * bail early instead of burning the rest of `maxRepair`. Together with the `maxRepair` cap this makes the
 * repair loop provably converge.
 */
export function madeProgress(prev: ProgressSnapshot | undefined, next: ProgressSnapshot): boolean {
  if (!prev) return true; // first attempt — nothing to compare against
  if (next.greenRatio > prev.greenRatio) return true;
  return next.failSignature !== prev.failSignature;
}
