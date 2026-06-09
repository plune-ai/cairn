import { describe, it, expect } from "vitest";
import { judgeTestCases, judgeChecklistCoverage } from "../../src/eval/judge.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { TestCase } from "../../src/design/index.js";

const tc: TestCase = {
  id: "tc-1",
  title: "Логін валідними даними",
  technique: "equivalence-partitioning",
  preconditions: [],
  steps: ["Ввести email", "Натиснути Sign In"],
  expected: "Успіх",
  priority: "high",
  elementRefs: ["e3"],
};

describe("judgeTestCases (SDK-side LLM judge)", () => {
  it("→ scores test_case_quality + methodology_adherence; prompt contains the cases", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ test_case_quality: 0.8, methodology_adherence: 0.7, comment: "ок" });
    };
    const scores = await judgeTestCases([tc], "Форма логіну", fakeInvoke, new PromptRegistry());
    expect(scores.find((s) => s.name === "test_case_quality")?.value).toBe(0.8);
    expect(scores.find((s) => s.name === "methodology_adherence")?.value).toBe(0.7);
    expect(captured).toContain("Логін валідними даними");
  });

  it("empty cases → [] (no invocation)", async () => {
    let called = false;
    const fakeInvoke: StructuredInvoke = async (schema) => {
      called = true;
      return schema.parse({ test_case_quality: 0, methodology_adherence: 0, comment: "" });
    };
    expect(await judgeTestCases([], "x", fakeInvoke, new PromptRegistry())).toEqual([]);
    expect(called).toBe(false);
  });

  it("judgeChecklistCoverage: semantic coverage + uncovered; empty checklist → 0 without invocation", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({ coverage: 0.75, uncovered: ["TC-05"] });
    const r = await judgeChecklistCoverage(
      [{ text: "TC-01" }, { text: "TC-05" }],
      [tc],
      fake,
      new PromptRegistry(),
    );
    expect(r.value).toBe(0.75);
    expect(r.comment).toContain("TC-05");

    let called = false;
    const fake2: StructuredInvoke = async (s) => {
      called = true;
      return s.parse({ coverage: 0, uncovered: [] });
    };
    expect((await judgeChecklistCoverage([], [], fake2, new PromptRegistry())).value).toBe(0);
    expect(called).toBe(false);
  });
});
