# Metrics

Every run scores itself. The numbers appear in the console (`=== Metrics ===`), in each run's
`report.md` (with a one-line meaning per metric), and in Langfuse when configured. **↑ = higher is
better, ↓ = lower is better.** `case_redundancy` and `flaky_ratio` are the **only** "lower is better"
metrics — every other metric is higher-is-better.

<!-- KEEP IN SYNC with src/eval/legend.ts (METRIC_LEGEND) — same metric names, directions, and blurbs. -->

**Deterministic** (computed from run data, no LLM):

| metric | direction | meaning |
|---|---|---|
| `runs_green` | ↑ higher is better | Share of generated tests that pass on validation. |
| `flaky_ratio` | ↓ lower is better | Share of tests classified flaky (inconsistent pass/fail). |
| `verified_ratio` | ↑ higher is better | Share of identified elements that resolve to exactly one element (unique locator). |
| `grounding` | ↑ higher is better | Share of cases whose element refs all point to real on-page elements (no hallucinated refs). |
| `locator_quality` | ↑ higher is better | Share of user-facing locators (getByRole/Label/Text…) vs fragile (.locator/getByTestId). |
| `locator_robustness` | ↑ higher is better | Weighted selector strength: role 1.0 > label/text 0.8 > test-id 0.5 > css 0. |
| `technique_coverage` | ↑ higher is better | Distinct test techniques used out of the 6 (ISO/IEC/IEEE 29119-4). |
| `case_redundancy` | ↓ lower is better | Share of cases that are near-duplicates of another (0 = all distinct). |

**Judge** (LLM-scored):

| metric | direction | meaning |
|---|---|---|
| `test_case_quality` | ↑ higher is better | Holistic quality of the cases (clarity, correctness, usefulness). |
| `methodology_adherence` | ↑ higher is better | How well the cases follow the testing methodology. |
| `checklist_coverage` | ↑ higher is better | Semantic coverage of the provided checklist by the cases. |

(The holistic **Pilot** verdict is separate — a pass / needs-work / fail judgment on the whole run, not a 0–1 score.)
