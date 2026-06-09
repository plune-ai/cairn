import { describe, it, expect } from "vitest";
import { pilotReview } from "../../src/eval/pilot.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { TestCase } from "../../src/design/index.js";

const tc: TestCase = {
  id: "tc-1",
  title: "Логін",
  technique: "exploratory",
  kind: "static",
  type: "Positive",
  preconditions: [],
  steps: ["крок"],
  expected: "ок",
  priority: "high",
  elementRefs: ["e1"],
};

describe("pilotReview (supervisor)", () => {
  it("→ verdict/reason/guidance; prompt contains the validation summary", async () => {
    let captured = "";
    const fake: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ verdict: "needs-work", reason: "мало негативних", guidance: "додай BVA-кейси" });
    };
    const v = await pilotReview(
      "Форма логіну",
      { results: [{ test: "a", status: "passed" }], greenRatio: 1, flakyCount: 0 },
      [tc],
      fake,
      new PromptRegistry(),
    );
    expect(v.verdict).toBe("needs-work");
    expect(v.guidance).toContain("BVA");
    expect(captured).toContain("100% green");
  });
});
