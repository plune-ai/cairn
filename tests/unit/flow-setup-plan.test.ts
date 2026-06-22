import { describe, it, expect } from "vitest";
import { planSetup } from "../../src/flow/setup.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { JourneyCase } from "../../src/design/schema.js";

const journey: JourneyCase = {
  id: "journey-1",
  title: "Edit an existing item",
  technique: "state-transition",
  type: "Positive",
  preconditions: ["an existing item in the list", "a logged-in user"],
  steps: [
    { page: "http://app/items", action: "open item", elementRefs: ["e1"] },
    { page: "http://app/items/1", action: "see editor", elementRefs: ["e2"] },
  ],
  expected: "editor is visible",
  priority: "high",
};

describe("planSetup (#60)", () => {
  it("turns prose preconditions into a structured plan", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({
        preconditions: [
          { description: "a logged-in user", strategy: "session" },
          { description: "an existing item", strategy: "fixture", entity: "item" },
        ],
      });
    const plan = await planSetup({ journey }, { invoke: fake, prompts: new PromptRegistry() });
    expect(plan.preconditions.map((p) => p.strategy)).toEqual(["session", "fixture"]);
    expect(plan.preconditions[1]?.entity).toBe("item");
  });

  it("downgrades api-seed WITHOUT an endpoint to manual (never fabricate seeding)", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({ preconditions: [{ description: "seed three items", strategy: "api-seed" }] });
    const plan = await planSetup({ journey }, { invoke: fake, prompts: new PromptRegistry() });
    expect(plan.preconditions[0]?.strategy).toBe("manual");
  });

  it("keeps api-seed when a concrete endpoint is given", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({
        preconditions: [{ description: "an item exists", strategy: "api-seed", endpoint: "/api/items", method: "POST" }],
      });
    const plan = await planSetup({ journey }, { invoke: fake, prompts: new PromptRegistry() });
    expect(plan.preconditions[0]?.strategy).toBe("api-seed");
    expect(plan.preconditions[0]?.endpoint).toBe("/api/items");
  });
});
