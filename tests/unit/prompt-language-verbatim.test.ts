import { describe, it, expect } from "vitest";
import { QA_TESTCASE_FROM_UI } from "../../src/prompts/local/qa-testcase-from-ui.js";
import { QA_GAP_CASES } from "../../src/prompts/local/qa-gap-cases.js";
import { QA_CASE_CRITIQUE } from "../../src/prompts/local/qa-case-critique.js";
import { QA_JOURNEY_FROM_FLOW } from "../../src/prompts/local/qa-journey-from-flow.js";

// #325: {{language}} governs the case's own wording; text the page shows must stay as the page shows it,
// or a text check looks for a translated string on a page that never displays it.
describe.each([
  ["qa-testcase-from-ui", QA_TESTCASE_FROM_UI],
  ["qa-gap-cases", QA_GAP_CASES],
  ["qa-case-critique", QA_CASE_CRITIQUE],
  ["qa-journey-from-flow", QA_JOURNEY_FROM_FLOW],
])("%s prompt (#325)", (_name, prompt) => {
  it("writes the case in {{language}} but quotes page text verbatim, untranslated", () => {
    expect(prompt).toContain("{{language}}");
    expect(prompt).toMatch(/quoted verbatim in the page's own language, never translated/);
  });
});
