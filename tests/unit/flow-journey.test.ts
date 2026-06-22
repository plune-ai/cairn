import { describe, it, expect } from "vitest";
import { designJourneys, groundJourney } from "../../src/flow/journey.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { FlowGraph, FlowNode } from "../../src/flow/crawl.js";
import type { DesignedJourney } from "../../src/design/schema.js";

const node = (url: string, refs: string[]): FlowNode => ({
  url,
  study: { url, screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] },
  verified: refs.map((ref) => ({ ref, role: "button", name: `el-${ref}`, interactive: true, rank: 3, count: 1, verified: true })),
  transitions: [],
});

const graph: FlowGraph = {
  nodes: [node("http://app/login", ["e1", "e2"]), node("http://app/dash", ["e9"])],
  edges: [{ from: "http://app/login", to: "http://app/dash", via: { ref: "e2", role: "link", name: "Sign in" } }],
};

describe("groundJourney (#59)", () => {
  it("filters each step's refs to those present on THAT step's page", () => {
    const j: DesignedJourney = {
      title: "Login then open dashboard",
      technique: "state-transition",
      type: "Positive",
      preconditions: [],
      steps: [
        { page: "http://app/login", action: "fill + submit", elementRefs: ["e1", "eGHOST"] },
        { page: "http://app/dash", action: "see dashboard", elementRefs: ["e9", "e1"] }, // e1 belongs to login, not dash
      ],
      expected: "dashboard visible",
      priority: "high",
    };
    const refsByPage = new Map([
      ["http://app/login", new Set(["e1", "e2"])],
      ["http://app/dash", new Set(["e9"])],
    ]);
    const grounded = groundJourney(j, refsByPage);
    expect(grounded.steps[0]?.elementRefs).toEqual(["e1"]); // eGHOST dropped
    expect(grounded.steps[1]?.elementRefs).toEqual(["e9"]); // e1 (wrong page) dropped
  });
});

describe("designJourneys (#59)", () => {
  it("generates grounded journey cases spanning ≥2 pages; drops single-page ones", async () => {
    const fake: StructuredInvoke = async (schema) =>
      schema.parse({
        journeys: [
          {
            title: "Login → dashboard",
            technique: "state-transition",
            type: "Positive",
            preconditions: ["a registered user"],
            steps: [
              { page: "http://app/login", action: "Sign in", elementRefs: ["e2"] },
              { page: "http://app/dash", action: "See dashboard", elementRefs: ["e9", "eGHOST"] },
            ],
            expected: "dashboard is visible",
            priority: "high",
          },
          {
            // single-page "journey" — must be dropped (a journey spans ≥2 pages)
            title: "Just login",
            technique: "exploratory",
            type: "Positive",
            preconditions: [],
            steps: [{ page: "http://app/login", action: "look", elementRefs: ["e1"] }],
            expected: "login form visible",
            priority: "low",
          },
        ],
      });

    const journeys = await designJourneys(
      { graph },
      { invoke: fake, prompts: new PromptRegistry() },
    );

    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.id).toBe("journey-1");
    expect(journeys[0]?.steps).toHaveLength(2);
    expect(journeys[0]?.steps[1]?.elementRefs).toEqual(["e9"]); // eGHOST grounded out per page
  });

  it("empty graph (single node) → no journeys", async () => {
    const fake: StructuredInvoke = async (schema) => schema.parse({ journeys: [] });
    const journeys = await designJourneys(
      { graph: { nodes: [node("http://app/x", ["e1"])], edges: [] } },
      { invoke: fake, prompts: new PromptRegistry() },
    );
    expect(journeys).toEqual([]);
  });
});
