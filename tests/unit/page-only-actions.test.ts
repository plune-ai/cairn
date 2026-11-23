import { describe, it, expect } from "vitest";
import { QA_TESTCASE_FROM_UI } from "../../src/prompts/local/qa-testcase-from-ui.js";
import { QA_GAP_CASES } from "../../src/prompts/local/qa-gap-cases.js";
import { QA_CASE_CRITIQUE } from "../../src/prompts/local/qa-case-critique.js";
import { QA_JOURNEY_FROM_FLOW } from "../../src/prompts/local/qa-journey-from-flow.js";
import { QA_PLAYWRIGHT_TS_WRITER } from "../../src/prompts/local/qa-playwright-ts-writer.js";
import { JUDGE_TEST_CASES_RUN } from "../../src/prompts/local/judge-test-cases-run.js";

// #333: an action whose effect stays in the page is automated; only a server or session write is left to a human.
// The write guard (#285) still blocks any write a test sends at run time.
describe.each([
  ["qa-testcase-from-ui", QA_TESTCASE_FROM_UI],
  ["qa-gap-cases", QA_GAP_CASES],
  ["qa-case-critique", QA_CASE_CRITIQUE],
  ["qa-journey-from-flow", QA_JOURNEY_FROM_FLOW],
  ["qa-playwright-ts-writer", QA_PLAYWRIGHT_TS_WRITER],
])("%s prompt (#333)", (_name, prompt) => {
  it("automates page-only actions and judges an action by what it does, not its label", () => {
    expect(prompt).toMatch(/Page-only actions are automated: click, toggle, type, key press, hover, a browser dialog/);
    expect(prompt).toMatch(/changes data on a server or the session/);
    expect(prompt).toMatch(/never by a word in its label such as Add or Remove/);
    expect(prompt).not.toMatch(/Log out, Add/);
  });
});

describe("design and judge prompts (#333)", () => {
  it("the design prompt no longer limits auto to read-only checks", () => {
    expect(QA_TESTCASE_FROM_UI).not.toMatch(/read-only checks on verified locators/);
    expect(QA_TESTCASE_FROM_UI).toMatch(/performs it and checks its visible result/);
  });
  it("the run judge does not give 1 to a suite that left a page-only core action manual", () => {
    expect(JUDGE_TEST_CASES_RUN).toMatch(/left manual is not confirmed: such a suite is not a 1/);
  });
});
