import { describe, it, expect } from "vitest";
import { designGapCases } from "../../src/eval/gap-cases.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { CoverageGap } from "../../src/eval/coverage.js";

const gaps: CoverageGap[] = [
  { page: "http://app/p1", ref: "e2", role: "textbox", name: "Email", why: "input never validated" },
];

describe("designGapCases (#61)", () => {
  it("suggests cases for untested surface, marked as suggestions and grounded to gap refs", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({
        testCases: [
          {
            title: "Validate Email rejects blank",
            technique: "boundary-value",
            type: "Negative",
            preconditions: [],
            steps: ["leave Email empty", "submit"],
            expected: "validation message shown",
            priority: "medium",
            elementRefs: ["e2", "eGHOST"], // eGHOST is not a gap ref → grounded out
          },
        ],
      });
    const cases = await designGapCases({ gaps }, { invoke: fake, prompts: new PromptRegistry() });
    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toMatch(/^gap-/); // clearly marked as a suggestion
    expect(cases[0]?.elementRefs).toEqual(["e2"]);
  });

  it("no gaps → no LLM call, empty result", async () => {
    let called = false;
    const fake: StructuredInvoke = async (schema) => {
      called = true;
      return schema.parse({ testCases: [] });
    };
    const cases = await designGapCases({ gaps: [] }, { invoke: fake, prompts: new PromptRegistry() });
    expect(cases).toEqual([]);
    expect(called).toBe(false);
  });
});
