import { describe, it, expect } from "vitest";
import { renderJourneySetup } from "../../src/codegen/journey-setup.js";
import type { JourneyCase } from "../../src/design/schema.js";
import type { FlowGraph } from "../../src/flow/crawl.js";
import type { SetupPlan } from "../../src/flow/setup.js";

const graph: FlowGraph = {
  nodes: [
    {
      url: "http://app/login",
      study: { url: "http://app/login", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] },
      verified: [{ ref: "e1", role: "textbox", name: "Email", interactive: true, rank: 3, count: 1, verified: true }],
      transitions: [],
    },
    {
      url: "http://app/dash",
      study: { url: "http://app/dash", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] },
      verified: [{ ref: "e9", role: "heading", name: "Dashboard", interactive: false, rank: 2, count: 1, verified: true }],
      transitions: [],
    },
  ],
  edges: [],
};

const journey: JourneyCase = {
  id: "journey-1",
  title: "Login to dashboard",
  technique: "state-transition",
  type: "Positive",
  preconditions: ["a registered user"],
  steps: [
    { page: "http://app/login", action: "Sign in", elementRefs: ["e1"] },
    { page: "http://app/dash", action: "See dashboard", elementRefs: ["e9"] },
  ],
  expected: "dashboard is visible",
  priority: "high",
};

const render = (plan: SetupPlan) => renderJourneySetup(journey, plan, graph, "http://app/login");

describe("renderJourneySetup (#60)", () => {
  it("always emits a runnable spec with read-only step assertions resolved per page", () => {
    const file = render({ preconditions: [{ description: "logged-in user", strategy: "session" }] });
    expect(file.path).toContain("journey-1");
    expect(file.content).toContain("import { test, expect } from '@playwright/test'");
    expect(file.content).toContain("getByRole('textbox', { name: 'Email' })"); // e1 on login page
    expect(file.content).toContain("getByRole('heading', { name: 'Dashboard' })"); // e9 on dash page
    expect(file.content).toContain("page.goto('http://app/dash')"); // page change between steps
    expect(file.content).toContain("toBeVisible()"); // read-only assertion
    // session is satisfied by storageState → documented as a comment, not a beforeEach
    expect(file.content).toContain("captured session");
  });

  it("a fixture precondition emits a beforeEach", () => {
    const file = render({ preconditions: [{ description: "a registered user", strategy: "fixture" }] });
    expect(file.content).toContain("test.beforeEach");
    expect(file.content).toContain("a registered user");
  });

  it("an api-seed precondition emits a request seed step", () => {
    const file = render({
      preconditions: [{ description: "an item exists", strategy: "api-seed", endpoint: "/api/items", method: "POST" }],
    });
    expect(file.content).toContain("test.beforeEach");
    expect(file.content).toContain("request.post('/api/items'");
  });

  it("a manual precondition is documented and the test is skipped (clean fallback, no fabrication)", () => {
    const file = render({ preconditions: [{ description: "a paid subscription", strategy: "manual" }] });
    expect(file.content).toContain("a paid subscription");
    expect(file.content).toMatch(/test\.skip\(/);
  });
});
