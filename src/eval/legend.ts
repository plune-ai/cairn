/**
 * Single source of truth for metric explanations — used by report.md (`renderReportMd`), the console
 * `=== Metrics ===` loops, and the docs/metrics.md table, so the three never drift.
 *
 * KEEP IN SYNC: docs/metrics.md mirrors this record (same blurbs + directions). If you change a
 * blurb/direction here, update docs/metrics.md too (and vice-versa). The metric NAMES must match
 * the score names produced by scorers.ts (deterministic) and judge.ts / agent (judge).
 */

export type MetricDir = "up" | "down"; // up = higher is better, down = lower is better
export type MetricKind = "deterministic" | "judge";
export interface MetricMeta {
  blurb: string;
  dir: MetricDir;
  kind: MetricKind;
}

export const METRIC_LEGEND: Record<string, MetricMeta> = {
  runs_green:            { dir: "up",   kind: "deterministic", blurb: "Share of generated tests that pass on validation." },
  flaky_ratio:           { dir: "down", kind: "deterministic", blurb: "Share of tests classified flaky (inconsistent pass/fail)." },
  verified_ratio:        { dir: "up",   kind: "deterministic", blurb: "Share of identified elements that resolve to exactly one element (unique locator)." },
  grounding:             { dir: "up",   kind: "deterministic", blurb: "Share of cases whose element refs all point to real on-page elements (no hallucinated refs)." },
  locator_quality:       { dir: "up",   kind: "deterministic", blurb: "Share of user-facing locators (getByRole/Label/Text…) vs fragile (.locator/getByTestId)." },
  locator_robustness:    { dir: "up",   kind: "deterministic", blurb: "Weighted selector strength: role 1.0 > label/text 0.8 > test-id 0.5 > css 0." },
  technique_coverage:    { dir: "up",   kind: "deterministic", blurb: "Distinct test techniques used out of the 6 (ISO/IEC/IEEE 29119-4)." },
  case_redundancy:       { dir: "down", kind: "deterministic", blurb: "Share of cases that are near-duplicates of another (0 = all distinct)." },
  test_case_quality:     { dir: "up",   kind: "judge",         blurb: "Holistic quality of the cases (clarity, correctness, usefulness)." },
  methodology_adherence: { dir: "up",   kind: "judge",         blurb: "How well the cases follow the testing methodology." },
  checklist_coverage:    { dir: "up",   kind: "judge",         blurb: "Semantic coverage of the provided checklist by the cases." },
};

/** "↑"/"↓" glyph for a metric (unknown → ""). */
export function dirGlyph(name: string): string {
  const d = METRIC_LEGEND[name]?.dir;
  return d === "up" ? "↑" : d === "down" ? "↓" : "";
}
