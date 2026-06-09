import { QA_TESTCASE_FROM_UI } from "./qa-testcase-from-ui.js";
import { QA_MANUAL_TEST_DESIGNER } from "./qa-manual-test-designer.js";
import { QA_PLAYWRIGHT_TS_WRITER } from "./qa-playwright-ts-writer.js";
import { IDENTIFY_ELEMENTS } from "./identify-elements.js";
import { JUDGE_TEST_CASES } from "./judge-test-cases.js";
import { JUDGE_CHECKLIST_COVERAGE } from "./judge-checklist-coverage.js";
import { PILOT_REVIEW } from "./pilot-review.js";

/** Local prompts (fallback, ADR-0004). Names match the Langfuse prompt names. */
export const LOCAL_PROMPTS: Record<string, string> = {
  "qa-testcase-from-ui": QA_TESTCASE_FROM_UI,
  "qa-manual-test-designer": QA_MANUAL_TEST_DESIGNER,
  "qa-playwright-ts-writer": QA_PLAYWRIGHT_TS_WRITER,
  "identify-elements": IDENTIFY_ELEMENTS,
  "judge-test-cases": JUDGE_TEST_CASES,
  "judge-checklist-coverage": JUDGE_CHECKLIST_COVERAGE,
  "pilot-review": PILOT_REVIEW,
};
