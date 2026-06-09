/** Test-case quality judge prompt (ADR-0006). Versioned like the methodology prompts. */
export const JUDGE_TEST_CASES = `You are a QA test-case quality judge. Evaluate the cases for the page: {{pageSemantics}}

Cases:
{{cases}}

Rate 0..1:
- test_case_quality: clarity, completeness (happy + negative + edge), uniqueness, verifiability;
- methodology_adherence: whether the cases reflect ISO/IEC/IEEE 29119-4 techniques (EP / BVA / decision-table / state-transition / error-guessing).
Return numbers + a short comment.`;
