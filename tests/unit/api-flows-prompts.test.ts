import { describe, it, expect } from "vitest";
import { designTestCases } from "../../src/design/index.js";
import { automateCases } from "../../src/codegen/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import { parseTestCaseMd } from "../../src/artifacts/testcase-md.js";
import { parseApiFlows, formatFlowsForPrompt, withFlowFixture, FLOW_FIXTURE_FILE } from "../../src/api/flows.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { ParsedTestCase } from "../../src/artifacts/testcase-md.js";

/** #230: `design` and `automate` see the available API flows and use them for data and sign-in preconditions. */
const flows = formatFlowsForPrompt(
  parseApiFlows(
    JSON.stringify({
      version: 1,
      flows: [
        {
          name: "project",
          description: "a project to open in the UI",
          steps: [{ method: "POST", path: "/api/projects", body: { name: "P {{uid}}" }, capture: { projectId: "/id" } }],
          returns: ["projectId"],
          cleanup: [{ method: "DELETE", path: "/api/projects/{{projectId}}" }],
        },
      ],
    }),
  ),
);

const study: PageStudy = {
  url: "http://x/projects",
  screenshotB64: "",
  ariaYaml: "",
  capturedBy: "lib",
  elements: [{ ref: "e1", role: "heading", name: "Projects", interactive: true, rank: 3 }],
};

const capture = (): { invoke: StructuredInvoke; text: () => string } => {
  let captured = "";
  const invoke: StructuredInvoke = async (schema, messages) => {
    captured = messages.map((m) => String(m.content)).join("\n");
    return schema.parse({ testCases: [], files: [{ path: "a.spec.ts", content: "x" }] });
  };
  return { invoke, text: () => captured };
};

describe("design sees the API flows (#230)", () => {
  it("is told to write a data precondition as the flow, not as UI steps", async () => {
    const c = capture();
    await designTestCases({ study, pageSemantics: "Projects", apiFlows: flows }, { invoke: c.invoke, prompts: new PromptRegistry() });
    expect(c.text()).toContain("- project (creates data; returns projectId; its cleanup deletes it afterwards) — a project to open in the UI");
    expect(c.text()).toContain('write that precondition as "API flow <name>: <what it gives>"');
  });

  it("without flows the prompt has no API flow section (a run without --flows is unchanged)", async () => {
    const c = capture();
    await designTestCases({ study, pageSemantics: "Projects" }, { invoke: c.invoke, prompts: new PromptRegistry() });
    expect(c.text()).not.toContain("API flow");
  });
});

describe("automate sees the API flows (#230)", () => {
  const cases: ParsedTestCase[] = [
    {
      id: "ATC-1",
      stableId: "",
      execution: "auto",
      title: "A project opens",
      preconditions: ["API flow project: a project exists (projectId)"],
      steps: ["Open the project page"],
      expected: ["The project's name is the heading"],
      selectors: [],
    },
  ];

  it("gets each case's preconditions and is told to import the fixture instead of creating data through the UI", async () => {
    const c = capture();
    await automateCases(cases, { baseUrl: "http://x", pageSemantics: "p", apiFlows: flows }, { invoke: c.invoke, prompts: new PromptRegistry() });
    expect(c.text()).toContain("Preconditions: API flow project: a project exists (projectId)");
    expect(c.text()).toContain("import { test, expect } from './api-flows.fixture';");
    expect(c.text()).toContain("- project (creates data; returns projectId;");
  });

  it("without flows the prompt is what it was: no preconditions line, no fixture", async () => {
    const c = capture();
    await automateCases(cases, { baseUrl: "http://x", pageSemantics: "p" }, { invoke: c.invoke, prompts: new PromptRegistry() });
    expect(c.text()).not.toContain("Preconditions:");
    expect(c.text()).not.toContain("api-flows.fixture");
  });

  it("the suite carries the fixture module Cairn wrote, never one the model wrote", () => {
    const suite = withFlowFixture(
      { files: [{ path: "a.spec.ts", content: "spec" }, { path: FLOW_FIXTURE_FILE, content: "from the model" }] },
      "the real fixture",
    );
    expect(suite.files).toEqual([
      { path: "a.spec.ts", content: "spec" },
      { path: FLOW_FIXTURE_FILE, content: "the real fixture" },
    ]);
  });

  it("an ATC file's preconditions are read back (\"(none)\" is no precondition)", () => {
    const md = "---\nid: ATC-1\nexecution: auto\n---\n# ATC-1: T\n\n## Preconditions\n\n- API flow project: a project exists\n\n## Steps\n\n1. Open\n";
    expect(parseTestCaseMd(md).preconditions).toEqual(["API flow project: a project exists"]);
    expect(parseTestCaseMd("---\nid: ATC-2\n---\n## Preconditions\n\n- (none)\n").preconditions).toEqual([]);
  });
});

describe("the --flows flag on design and automate (#230)", () => {
  it("design and automate take --flows <file>; automate also takes --allow-mutations", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    const program = buildProgram();
    const opt = (cmd: string, flag: string) => program.commands.find((c) => c.name() === cmd)?.options.find((o) => o.long === flag);
    expect(opt("design", "--flows")?.required).toBe(true);
    expect(opt("automate", "--flows")?.required).toBe(true);
    expect(opt("automate", "--allow-mutations")).toBeDefined();
  });
});
