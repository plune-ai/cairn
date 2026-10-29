import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { runDesign } from "../../src/agent/index.js";

// No browser and no LLM: the graph, the browser preflight, the gateway and the judge are stubbed, so the
// test runs only what design writes to disk after the graph.
vi.mock("../../src/browser/preflight.js", () => ({ ensureBrowsersInstalled: () => undefined }));
vi.mock("../../src/browser/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/browser/index.js")>()),
  makeGateway: () => ({ close: async () => undefined }),
}));
vi.mock("../../src/eval/judge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/eval/judge.js")>()),
  judgeTestCases: async () => [],
}));
vi.mock("../../src/agent/graph.js", () => ({
  runExploreGraph: async () => ({
    study: { url: "https://app.test/login", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] },
    analysis: { pageSemantics: "A login page", primaryRefs: [], viewSwitchers: [] },
    verified: [],
    transitions: [],
    testCases: [
      {
        id: "tc-1",
        title: "loads the page",
        technique: "exploratory",
        kind: "static",
        type: "Positive",
        execution: "auto",
        preconditions: [],
        steps: ["open the page"],
        expected: "the page renders",
        priority: "high",
        elementRefs: [],
      },
    ],
    stoppedEarly: false,
    attempts: 0,
  }),
}));

const base = await mkdtemp(join(tmpdir(), "cairn-219-"));
afterAll(() => rm(base, { recursive: true, force: true }));

describe("design report.json · testCaseFiles (#219)", () => {
  it("keeps each case file relative to the run dir, with /, while the result still gives the absolute path", async () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "test-key-not-used" });
    const result = await runDesign({ url: "https://app.test/login", config, runsBaseDir: base, knowledgeDir: join(base, "none") });

    const report = JSON.parse(await readFile(join(result.runDir, "report.json"), "utf8")) as { testCaseFiles: string[] };
    expect(report.testCaseFiles).toEqual(["testcases/ATC-LOGIN-UI-001.md"]);
    // The stored path opens from the run dir, wherever the dir has moved.
    await expect(stat(join(result.runDir, report.testCaseFiles[0]!))).resolves.toBeTruthy();
    // CLI and MCP print the path for this machine, so the result keeps it absolute.
    expect(result.testCaseFiles).toEqual([join(result.runDir, "testcases", "ATC-LOGIN-UI-001.md")]);
  });
});
