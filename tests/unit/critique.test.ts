import { describe, it, expect } from "vitest";
import { critiqueCases } from "../../src/design/critique.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { TestCase } from "../../src/design/schema.js";

const tc = (over: Partial<TestCase>): TestCase => ({
  id: "tc-1",
  title: "t",
  technique: "equivalence-partitioning",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["s"],
  expected: "e",
  priority: "medium",
  elementRefs: [],
  ...over,
});

describe("critiqueCases (#82)", () => {
  it("prunes the cases the critique drops (by id) and records the delta", async () => {
    const cases = [tc({ id: "tc-1" }), tc({ id: "tc-2", title: "trivial dup" })];
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({ drop: [{ id: "tc-2", reason: "trivial" }], add: [] });

    const { cases: out, delta } = await critiqueCases(
      { testCases: cases, pageSemantics: "x", knownRefs: [] },
      { invoke: fake, prompts: new PromptRegistry() },
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("t");
    expect(delta.before).toBe(2);
    expect(delta.after).toBe(1);
    expect(delta.pruned).toBe(1);
    expect(delta.prunedTitles).toEqual(["trivial dup"]);
  });

  it("tops up an under-represented technique and grounds the new refs", async () => {
    const cases = [tc({ id: "tc-1", technique: "equivalence-partitioning", elementRefs: ["e1"] })];
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({
        drop: [],
        add: [
          {
            title: "Boundary",
            technique: "boundary-value",
            kind: "static",
            type: "Positive",
            execution: "auto",
            preconditions: [],
            steps: ["enter min"],
            expected: "accepted",
            priority: "low",
            elementRefs: ["e1", "eGHOST"],
          },
        ],
      });

    const { cases: out, delta } = await critiqueCases(
      { testCases: cases, pageSemantics: "x", knownRefs: ["e1"] },
      { invoke: fake, prompts: new PromptRegistry() },
    );

    expect(out).toHaveLength(2);
    const boundary = out.find((c) => c.technique === "boundary-value");
    expect(boundary?.elementRefs).toEqual(["e1"]); // eGHOST grounded out (anti-hallucination)
    expect(delta.toppedUp).toBe(1);
    expect(delta.techniquesAdded).toContain("boundary-value");
    expect(delta.techniqueCoverageAfter).toBeGreaterThan(delta.techniqueCoverageBefore);
  });

  it("surfaces the missing techniques + current cases to the model", async () => {
    let captured = "";
    const fake: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ drop: [], add: [] });
    };

    await critiqueCases(
      { testCases: [tc({ id: "tc-1", technique: "equivalence-partitioning" })], pageSemantics: "Login form", knownRefs: ["e1"] },
      { invoke: fake, prompts: new PromptRegistry() },
    );

    expect(captured).toContain("boundary-value"); // an under-represented technique is offered for top-up
    expect(captured).toContain("tc-1"); // the existing case is shown for the prune decision
  });

  it("is a no-op when the critique neither drops nor adds", async () => {
    const cases = [tc({ id: "tc-1" })];
    const fake: StructuredInvoke = async (schema) => schema.parse({ drop: [], add: [] });
    const { cases: out, delta } = await critiqueCases(
      { testCases: cases, pageSemantics: "x", knownRefs: [] },
      { invoke: fake, prompts: new PromptRegistry() },
    );
    expect(out).toHaveLength(1);
    expect(delta.pruned).toBe(0);
    expect(delta.toppedUp).toBe(0);
  });
});
