import { describe, it, expect } from "vitest";
import { designTestCases } from "../../src/design/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";

const study: PageStudy = {
  url: "http://x/login",
  screenshotB64: "",
  ariaYaml: "",
  capturedBy: "lib",
  elements: [
    { ref: "e6", role: "button", name: "Sign In", interactive: true, rank: 3 },
    { ref: "e3", role: "textbox", name: "Email", interactive: true, rank: 3 },
  ],
};

describe("designTestCases", () => {
  it("→ TestCase[] with ids; grounding drops nonexistent refs; prompt contains the context", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({
        testCases: [
          {
            title: "Логін валідними даними",
            technique: "equivalence-partitioning",
            preconditions: [],
            steps: ["Ввести email", "Ввести пароль", "Натиснути Sign In"],
            expected: "Користувач залогінений",
            priority: "high",
            elementRefs: ["e3", "e6", "eGHOST"],
          },
        ],
      });
    };

    const cases = await designTestCases(
      { study, pageSemantics: "Форма логіну" },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
    );

    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toBe("tc-1");
    expect(cases[0]?.technique).toBe("equivalence-partitioning");
    // grounding: eGHOST dropped (not present in study.elements)
    expect(cases[0]?.elementRefs).toEqual(["e3", "e6"]);
    // prompt received the semantics and the elements
    expect(captured).toContain("Форма логіну");
    expect(captured).toContain("Sign In");
  });

  it("empty result → []", async () => {
    const fakeInvoke: StructuredInvoke = async (schema) => schema.parse({ testCases: [] });
    const cases = await designTestCases(
      { study, pageSemantics: "x" },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
    );
    expect(cases).toEqual([]);
  });
});
