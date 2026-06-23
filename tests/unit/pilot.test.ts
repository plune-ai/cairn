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
      return schema.parse({ verdict: "needs-work", reason: "мало негативних", guidance: "додай BVA-кейси", entity: "" });
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

  it("#91: rejects a 'pass' whose claimed entity is absent from the session log", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({ verdict: "pass", reason: "all good", guidance: "ship", entity: "Phantom Record" });
    const v = await pilotReview("Форма", undefined, [tc], fake, new PromptRegistry(), ["clicked Save", "opened /items"]);
    expect(v.verdict).toBe("needs-work"); // entity not in the log → provenance downgrade
    expect(v.reason).toMatch(/provenance/i);
  });

  it("#91: keeps a 'pass' when the entity is present in the session log", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({ verdict: "pass", reason: "all good", guidance: "ship", entity: "Order 7" });
    const v = await pilotReview("Форма", undefined, [tc], fake, new PromptRegistry(), ["created Order 7"]);
    expect(v.verdict).toBe("pass");
  });
});
