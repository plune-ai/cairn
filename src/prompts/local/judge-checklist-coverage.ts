/** Semantic checklist-coverage judge prompt (cross-language, ADR-0006). */
export const JUDGE_CHECKLIST_COVERAGE = `Evaluate the SEMANTIC coverage of the checklist by the generated cases. The checklist and the cases may be in DIFFERENT LANGUAGES — compare by MEANING, not by words.

Checklist:
{{items}}

Generated cases:
{{cases}}

coverage — the fraction of checklist items covered by at least one case by meaning (0..1). uncovered — items with no coverage.`;
