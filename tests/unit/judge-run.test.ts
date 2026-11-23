import { describe, it, expect } from "vitest";
import { judgeTestCases } from "../../src/eval/judge.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { TestCase } from "../../src/design/index.js";

// #327: with a run, the judge sees each case's test status; without one, the old prompt stays and says so.
const mk = (id: string, title: string, execution: "auto" | "manual" = "auto"): TestCase => ({
  id, title, technique: "equivalence-partitioning", preconditions: [], steps: ["Open the page"],
  expected: "It works", priority: "high", elementRefs: [], execution,
});
const cases = [mk("tc-1", "Submit with 'valid' data"), mk("tc-2", "Error on empty email"), mk("tc-3", "Looks right on mobile", "manual")];

function capture(): { invoke: StructuredInvoke; text: () => string } {
  let captured = "";
  const invoke: StructuredInvoke = async (schema, messages) => {
    captured = JSON.stringify(messages);
    return schema.parse({ test_case_quality: 0.5, methodology_adherence: 0.6, comment: "core action unconfirmed" });
  };
  return { invoke, text: () => captured };
}

describe("judgeTestCases with run results (#327)", () => {
  it("gives the judge each case's status, the unmatched results, the green share and the goal", async () => {
    const c = capture();
    const scores = await judgeTestCases(cases, "Sign-up form", c.invoke, new PromptRegistry(), {
      validation: {
        results: [
          { test: "tc-1: Submit with valid data", status: "passed" },
          { test: "Error on empty email", status: "failed" },
          { test: "Header logo is visible", status: "flaky" },
        ],
        greenRatio: 1 / 3,
        flakyCount: 1,
      },
      url: "https://example.test/signup",
      goal: "test sign-up",
    });
    const t = c.text();
    expect(t).toContain("[passed] [equivalence-partitioning] Submit with 'valid' data");
    expect(t).toContain("[failed] [equivalence-partitioning] Error on empty email");
    expect(t).toContain("[manual] [equivalence-partitioning] Looks right on mobile");
    expect(t).toContain("[flaky] Header logo is visible");
    expect(t).toContain("33%");
    expect(t).toContain("test sign-up");
    expect(t).toContain("https://example.test/signup");
    expect(t).toMatch(/core action/);
    expect(scores.find((s) => s.name === "test_case_quality")).toEqual({ name: "test_case_quality", value: 0.5, comment: "core action unconfirmed" });
  });

  it("an automated case with no matching result is 'not run'", async () => {
    const c = capture();
    await judgeTestCases([mk("tc-9", "Opens the menu")], "x", c.invoke, new PromptRegistry(), {
      validation: { results: [], greenRatio: 0, flakyCount: 0 },
    });
    expect(c.text()).toContain("[not run] [equivalence-partitioning] Opens the menu");
    expect(c.text()).toContain("(none: explore the page)");
  });

  it("without a run the old prompt stays and the comment is marked as cases-only", async () => {
    const c = capture();
    const scores = await judgeTestCases(cases, "x", c.invoke, new PromptRegistry());
    expect(c.text()).not.toMatch(/core action/);
    expect(scores.find((s) => s.name === "test_case_quality")?.comment).toBe("no run (cases only): core action unconfirmed");
  });
});
