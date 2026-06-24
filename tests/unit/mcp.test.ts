import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { exploreTool, designTool, ToolInputSchema, type ToolDeps } from "../../src/mcp/tools.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import type { ExploreResult, DesignResult } from "../../src/agent/index.js";

const tc = {
  id: "tc-1",
  title: "Login form visible",
  technique: "exploratory",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["open page"],
  expected: "form visible",
  priority: "high",
  elementRefs: ["e1"],
};

/** Mock core: captures the inputs each tool forwards, returns canned results. No browser / LLM. */
function makeDeps() {
  const calls: { config?: unknown; explore?: { url: string; flow?: boolean; maxPages?: number }; design?: { url: string } } = {};
  const deps: ToolDeps = {
    resolveConfig: (flags) => {
      calls.config = flags;
      return { llmProfile: "anthropic" } as unknown as ReturnType<typeof deps.resolveConfig>;
    },
    runExploration: async (input) => {
      calls.explore = input as typeof calls.explore;
      return {
        runId: "r1",
        runDir: "runs/r1",
        analysis: { pageSemantics: "login page" },
        testCases: [tc],
        validation: { greenRatio: 0.5, flakyCount: 0, results: [{ test: "a", status: "passed" }, { test: "b", status: "failed" }] },
        scores: [{ name: "grounding", value: 1 }],
        pilot: { verdict: "pass", reason: "ok", guidance: "ship" },
        cost: { total: 1 },
        testCaseFiles: ["testcases/tc-1.md"],
      } as unknown as ExploreResult;
    },
    runDesign: async (input) => {
      calls.design = input as typeof calls.design;
      return {
        runId: "d1",
        runDir: "runs/d1",
        analysis: { pageSemantics: "login page" },
        testCases: [tc],
        testCaseFiles: ["testcases/tc-1.md"],
        scores: [{ name: "grounding", value: 1 }],
        cost: { total: 1 },
      } as unknown as DesignResult;
    },
  };
  return { deps, calls };
}

describe("MCP explore/design tools (#49)", () => {
  it("exploreTool maps input → resolveConfig + runExploration and returns a compact result", async () => {
    const { deps, calls } = makeDeps();
    const r = await exploreTool({ url: "http://x", routing: "volume", flow: true, maxPages: 5 }, deps);

    expect(calls.config).toEqual({ backend: undefined, routing: "volume", channel: undefined }); // config reused
    expect(calls.explore?.url).toBe("http://x");
    expect(calls.explore?.flow).toBe(true);
    expect(calls.explore?.maxPages).toBe(5);

    expect(r.runId).toBe("r1");
    expect(r.pageSemantics).toBe("login page");
    expect(r.testCases[0]).toMatchObject({ id: "tc-1", title: "Login form visible", technique: "exploratory" });
    expect(r.validation).toEqual({ greenRatio: 0.5, passed: 1, failed: 1, flaky: 0 });
    expect(r.pilot).toEqual({ verdict: "pass", reason: "ok", guidance: "ship" });
  });

  it("flow off → maxPages stays undefined (no crawl)", async () => {
    const { deps, calls } = makeDeps();
    await exploreTool({ url: "http://x" }, deps);
    expect(calls.explore?.flow).toBeUndefined();
    expect(calls.explore?.maxPages).toBeUndefined();
  });

  it("designTool calls runDesign and returns cases without validation/pilot", async () => {
    const { deps, calls } = makeDeps();
    const r = await designTool({ url: "http://x" }, deps);
    expect(calls.design?.url).toBe("http://x");
    expect(r.runId).toBe("d1");
    expect(r.testCases).toHaveLength(1);
    expect(r).not.toHaveProperty("validation");
    expect(r).not.toHaveProperty("pilot");
  });

  it("invalid input (missing url) → clean validation failure", () => {
    expect(ToolInputSchema.safeParse({}).success).toBe(false);
    expect(ToolInputSchema.safeParse({ url: "http://x" }).success).toBe(true);
  });
});

describe("MCP server (#49)", () => {
  it("tools/list exposes exactly `explore` and `design`", async () => {
    const server = buildMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["design", "explore"]);
    // each tool advertises its input schema (url is required)
    const explore = tools.find((t) => t.name === "explore");
    expect(explore?.inputSchema).toBeDefined();

    await client.close();
  });
});
