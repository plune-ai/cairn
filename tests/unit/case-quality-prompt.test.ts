import { describe, it, expect } from "vitest";
import { QA_TESTCASE_FROM_UI } from "../../src/prompts/local/qa-testcase-from-ui.js";

describe("qa-testcase-from-ui prompt (case-quality #58)", () => {
  it("nudges technique breadth by naming specific 29119-4 techniques", () => {
    expect(QA_TESTCASE_FROM_UI).toMatch(/boundary-value/);
    expect(QA_TESTCASE_FROM_UI).toMatch(/equivalence-partitioning/);
    expect(QA_TESTCASE_FROM_UI).toMatch(/variety|breadth|diversif/i);
  });
});
