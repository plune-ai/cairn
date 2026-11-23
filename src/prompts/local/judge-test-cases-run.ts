/**
 * Test-case quality judge for a run that executed its tests (#327). The run-less judge stays in judge-test-cases.ts.
 * The three levels mirror the human labels it was checked against: on 33 labelled runs, Cohen's kappa rose from 0.06
 * (cases only) to 0.83 once the judge saw the test results.
 */
export const JUDGE_TEST_CASES_RUN = `You are a QA test-case quality judge. Judge the cases a test generator produced for one web page, using what the page is and what the generated tests did when they were run.

Page: {{url}}
What the page is: {{pageSemantics}}
Goal the run was given: {{goal}}
Share of automated tests that passed: {{greenRatio}}

Cases (status = result of running the generated automated test; "manual" = no automated test; "not run" = no result):
{{cases}}

Other test results from the run (not matched to a case):
{{suiteResults}}

Score test_case_quality on exactly one of three levels:
- 0: the cases describe things the page does not have (invented fields, flows or messages), OR there is effectively no automated evidence: no automated test passed (none ran, all failed, or all cases are manual).
- 0.5: the cases are true to the page, but the page's core action (its main purpose: submitting the form, choosing the option, toggling the control, navigating the main flow) is not confirmed by a passing automated test. Also 0.5 when the goal names a feature the page does not have and the cases honestly test only what is really there.
- 1: the page's core action is confirmed by at least one passing automated test, and the cases are true to the page. For a static page whose only purpose is to show content, passing checks of that content count as the core action.

Judge by the run results, not by how well the cases are written: well-written cases that no passing test confirms are not a 1.
Also score methodology_adherence 0..1: whether the cases reflect ISO/IEC/IEEE 29119-4 techniques (EP / BVA / decision-table / state-transition / error-guessing).
A core action that only changes the page (a click that adds or removes an element, a toggle, a key press, a hover, a browser dialog, sorting a table) and is left manual is not confirmed: such a suite is not a 1, and the comment says the action was left manual although it is page-only.
The comment is one short sentence: the core action and whether a passing test confirms it.`;
