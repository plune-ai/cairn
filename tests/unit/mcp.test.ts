import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  exploreTool,
  designTool,
  automateTool,
  ToolInputSchema,
  AutomateInputSchema,
  ExploreToolResultSchema,
  type ToolDeps,
} from "../../src/mcp/tools.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { BrowserBackendSchema, DeciderProviderSchema } from "../../src/config/schema.js";
import { ROUTING_PRESETS } from "../../src/config/profiles.js";
import type { ExploreResult, DesignResult, AutomateResult } from "../../src/agent/index.js";

const cost = { perRole: [{ role: "worker", models: ["m"], calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null }], totalTokens: 2, totalCostUsd: null };

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
  const calls: {
    config?: unknown;
    explore?: { url: string; flow?: boolean; maxPages?: number };
    design?: { url: string };
    automate?: { runDir: string; validate?: boolean; sessionName?: string };
  } = {};
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
        cost,
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
        cost,
      } as unknown as DesignResult;
    },
    runAutomate: async (input) => {
      calls.automate = input as typeof calls.automate;
      return {
        runDir: "runs/a1",
        specFiles: ["tests/login.spec.ts"],
        validation: { greenRatio: 1, flakyCount: 0, results: [{ test: "x", status: "passed" }] },
        cost,
        budget: {},
        stoppedEarly: false,
      } as unknown as AutomateResult;
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

  it("`decider` passes through to resolveConfig for explore, design and automate (ADR-0022)", async () => {
    const { deps, calls } = makeDeps();
    await exploreTool({ url: "http://x", decider: "laya" }, deps);
    expect(calls.config).toMatchObject({ decider: "laya" });
    await designTool({ url: "http://x", decider: "jev" }, deps);
    expect(calls.config).toMatchObject({ decider: "jev" });
    await automateTool({ run: "runs/r1", decider: "off" }, deps);
    expect(calls.config).toMatchObject({ decider: "off" });
    expect(ToolInputSchema.safeParse({ url: "http://x", decider: 1 }).success).toBe(false);
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

  it("automateTool calls runAutomate with the run dir + session, returns spec files", async () => {
    const { deps, calls } = makeDeps();
    const r = await automateTool({ run: "runs/r1", validate: true, session: "demo", routing: "volume" }, deps);
    expect(calls.config).toEqual({ routing: "volume", channel: undefined }); // config reused (no backend for automate)
    expect(calls.automate?.runDir).toBe("runs/r1");
    expect(calls.automate?.validate).toBe(true);
    expect(calls.automate?.sessionName).toBe("demo");
    expect(r.specFiles).toEqual(["tests/login.spec.ts"]);
    expect(r.validation).toEqual({ greenRatio: 1, passed: 1, failed: 0, flaky: 0 });
  });

  it("automateTool returns the decision layer and the tests it kept out of repair — automate writes no report", async () => {
    const { deps } = makeDeps();
    const decider = { provider: "laya", model: "multilingual", calls: 2, fallbacks: [] };
    const notRepaired = [{ test: "x", category: "app-bug", confidence: 0.9, exclude: true }];
    const healed = [{ test: "y", from: "getByRole('button', { name: 'Sign' })", to: "getByRole('button', { name: 'Sign in', exact: true })", confidence: 0.9 }];
    const base = deps.runAutomate;
    deps.runAutomate = async (input) => ({ ...(await base(input)), decider, notRepaired, healed }) as unknown as AutomateResult;
    expect(await automateTool({ run: "runs/r1", validate: true, decider: "laya" }, deps)).toMatchObject({ decider, notRepaired, healed });
  });

  it("without a decider the automate result has none of its keys", async () => {
    const r = await automateTool({ run: "runs/r1" }, makeDeps().deps);
    expect(r).not.toHaveProperty("decider");
    expect(r).not.toHaveProperty("notRepaired");
    expect(r).not.toHaveProperty("healed");
  });

  it("invalid input (missing url) → clean validation failure", () => {
    expect(ToolInputSchema.safeParse({}).success).toBe(false);
    expect(ToolInputSchema.safeParse({ url: "http://x" }).success).toBe(true);
    expect(AutomateInputSchema.safeParse({}).success).toBe(false); // automate needs `run`
    expect(AutomateInputSchema.safeParse({ run: "runs/r1" }).success).toBe(true);
  });
});

describe("MCP server (#49)", () => {
  it("tools/list exposes exactly `explore`, `design`, and `automate`", async () => {
    const server = buildMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["automate", "design", "explore"]);
    // each tool advertises its input schema (url is required)
    const explore = tools.find((t) => t.name === "explore");
    expect(explore?.inputSchema).toBeDefined();

    await client.close();
  });
});

/** An in-memory client on a server whose tools run the mocked core: no browser, no model calls. */
async function connect(deps: ToolDeps = makeDeps().deps) {
  const server = buildMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return { client, tools, tool: (name: string) => tools.find((t) => t.name === name)! };
}

/**
 * What each tool does to the world, read from the code (the hints are a claim the server makes, so they follow it):
 * - explore: a new runs/<uuid>/ per call; `intoProject` adds specs and renames its own file on a name clash, never
 *   overwriting a project file (ejectSuiteToProject) → not destructive; a new run id each time → not idempotent.
 * - design: a new runs/<uuid>/ per call and nothing else → not destructive, not idempotent.
 * - automate: writes into the run it is given; writeSuite empties that run's tests/ first, and with `intoProject` the
 *   run's tests/ is removed → destructive; with `intoProject` a repeated call adds renamed copies → not idempotent.
 */
const EXPECTED_HINTS = {
  explore: { destructiveHint: false, idempotentHint: false },
  design: { destructiveHint: false, idempotentHint: false },
  automate: { destructiveHint: true, idempotentHint: false },
};

describe("MCP · tools/list · hints and closed values", () => {
  it("MCP · tools/list · every tool writes files and reaches the outside world", async () => {
    const { client, tools } = await connect();
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      expect(t.title, t.name).toBeTruthy();
    }
    await client.close();
  });

  it("MCP · tools/list · destructive and idempotent hints match the behaviour read from the code", async () => {
    const { client, tools } = await connect();
    expect(Object.fromEntries(tools.map((t) => [t.name, { destructiveHint: t.annotations?.destructiveHint, idempotentHint: t.annotations?.idempotentHint }]))).toEqual(
      EXPECTED_HINTS,
    );
    await client.close();
  });

  it("MCP · tools/list · decider, routing and backend list exactly the values the configuration knows", async () => {
    const { client, tool } = await connect();
    for (const name of ["explore", "design", "automate"]) {
      const props = tool(name).inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(props.decider?.enum, name).toEqual(DeciderProviderSchema.options);
      expect(props.routing?.enum, name).toEqual(Object.keys(ROUTING_PRESETS));
      if (name !== "automate") expect(props.backend?.enum, name).toEqual(BrowserBackendSchema.options);
    }
    await client.close();
  });
});

describe("MCP · tools/call · closed values and structured results", () => {
  it.each([
    ["decider", { decider: "bogus" }],
    ["routing", { routing: "bogus" }],
    ["backend", { backend: "bogus" }],
  ])("MCP · tools/call · design with an unknown %s is a validation error, before any work", async (_, bad) => {
    const { deps, calls } = makeDeps();
    const { client } = await connect(deps);
    const r = await client.callTool({ name: "design", arguments: { url: "http://x", ...bad } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Input validation error");
    expect(calls.design).toBeUndefined();
    await client.close();
  });

  it("MCP · tools/call · automate with an unknown decider or routing is a validation error", async () => {
    const { client } = await connect();
    for (const bad of [{ decider: "bogus" }, { routing: "bogus" }]) {
      const r = await client.callTool({ name: "automate", arguments: { run: "runs/r1", ...bad } });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
      expect(JSON.stringify(r.content)).toContain("Input validation error");
    }
    await client.close();
  });

  it("MCP · tools/call · known values pass and every result carries structured content its schema accepts", async () => {
    const { deps, calls } = makeDeps();
    const { client } = await connect(deps);
    const known = { decider: "off", routing: "fast" };
    const results = {
      explore: await client.callTool({ name: "explore", arguments: { url: "http://x", backend: "lib", ...known } }),
      design: await client.callTool({ name: "design", arguments: { url: "http://x", backend: "cli", ...known } }),
      automate: await client.callTool({ name: "automate", arguments: { run: "runs/r1", ...known } }),
    };
    expect(calls.config).toMatchObject(known);
    for (const [name, r] of Object.entries(results)) {
      expect(r.isError, name).toBeFalsy();
      expect(r.structuredContent, name).toBeDefined(); // the client has already checked it against outputSchema
      expect(JSON.parse((r.content as { text: string }[])[0]!.text), name).toEqual(r.structuredContent);
    }
    await client.close();
  });

  it("MCP · tools/call · automate keeps its decision layer in the structured result", async () => {
    const { deps } = makeDeps();
    const decider = { provider: "laya", model: "multilingual", calls: 2, fallbacks: [] };
    const notRepaired = [{ test: "x", category: "app-bug", confidence: 0.9, exclude: true }];
    const healed = [{ test: "y", from: "a", to: "b", confidence: 0.9 }];
    const base = deps.runAutomate;
    deps.runAutomate = async (input) => ({ ...(await base(input)), decider, notRepaired, healed }) as unknown as AutomateResult;
    const { client } = await connect(deps);
    const r = await client.callTool({ name: "automate", arguments: { run: "runs/r1", decider: "laya" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ decider, notRepaired, healed });
    await client.close();
  });

  it("MCP · tools/call · a finished run whose result fails its schema is an error that names the run folder", async () => {
    const { deps } = makeDeps();
    const base = deps.runAutomate;
    deps.runAutomate = async (input) => ({ ...(await base(input)), runDir: "runs/r1-done", decider: { provider: 1 } }) as unknown as AutomateResult;
    const { client } = await connect(deps);
    const r = await client.callTool({ name: "automate", arguments: { run: "runs/r1" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("its files are in runs/r1-done");
    await client.close();
  });

  it("MCP · exploreTool · its result passes its own output schema", async () => {
    const r = await exploreTool({ url: "http://x" }, makeDeps().deps);
    expect(ExploreToolResultSchema.safeParse(r).success).toBe(true);
  });
});
