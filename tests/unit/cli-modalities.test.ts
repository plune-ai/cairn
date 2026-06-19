import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * C1-02: CLI parity + back-compat for the umbrella router (C1-01).
 *  - `explore` 1:1 parity: same flags accepted, same option mapping to runExploration, same output.
 *  - Gated stubs (ui|e2e|api|unit|docs): print the coming-soon notice, exit 0, NEVER call a runner.
 *  - Surface lock: snapshot `cairn --help` (now with the 4 stubs) and `cairn explore --help`.
 *
 * No live LLM/browser: the agent runners are mocked.
 */
const { runExploration, runDesign, runAutomate } = vi.hoisted(() => ({
  runExploration: vi.fn(),
  runDesign: vi.fn(),
  runAutomate: vi.fn(),
}));

vi.mock("../../src/agent/index.js", () => ({
  runExploration,
  runDesign,
  runAutomate,
  // re-exported by src/agent/index.ts (graph.js path) — must exist on the mocked module.
  runExploreGraph: vi.fn(),
}));

import { buildProgram } from "../../src/cli/index.js";

/** A minimal-but-complete ExploreResult so the explore renderer exercises every branch. */
const exploreFixture = {
  runId: "run-1",
  runDir: "/runs/run-1",
  study: { url: "https://app.test" },
  analysis: { pageSemantics: "A login page" },
  testCases: [
    {
      id: "tc-1",
      priority: "high",
      technique: "boundary-value",
      title: "Title",
      steps: ["step one"],
      expected: "ok",
      elementRefs: ["e1"],
    },
  ],
  validation: {
    results: [
      { test: "loads", status: "passed" },
      { test: "rejects empty", status: "failed" },
    ],
    greenRatio: 0.5,
    flakyCount: 0,
  },
  scores: [{ name: "grounding", value: 0.9, comment: "good" }],
  pilot: { verdict: "pass", reason: "looks fine", guidance: "ship it" },
  cost: {
    perRole: [
      { role: "worker", models: ["m"], calls: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.01 },
    ],
    totalTokens: 120,
    totalCostUsd: 0.01,
  },
  budget: { used: 5, max: 80 },
  stoppedEarly: false,
  testCaseFiles: ["/runs/run-1/testcases/ATC-1.md"],
};

let outChunks: string[];
let errChunks: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  runExploration.mockReset();
  runDesign.mockReset();
  runAutomate.mockReset();
  runExploration.mockResolvedValue(exploreFixture);
  // Deterministic config (independent of any .env): anthropic profile, no routing by default.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("LLM_PROFILE", "anthropic");
  vi.stubEnv("LLM_ROUTING", "");
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("explore parity (C1-02)", () => {
  it("accepts exactly the documented flag surface", () => {
    const explore = buildProgram().commands.find((c) => c.name() === "explore");
    expect(explore).toBeDefined();
    const longs = (explore?.options ?? []).map((o) => o.long);
    for (const f of [
      "--url",
      "--backend",
      "--channel",
      "--session",
      "--session-file",
      "--headed",
      "--checklist",
      "--style",
      "--fresh",
      "--routing",
    ]) {
      expect(longs, `explore should accept ${f}`).toContain(f);
    }
    expect(longs).toHaveLength(10); // + --fresh (ignore prior-run experience for a clean A/B run)
  });

  it("maps flags to runExploration the same way as before the refactor", async () => {
    await buildProgram().parseAsync([
      "node",
      "cairn",
      "explore",
      "--url",
      "https://app.test",
      "--session",
      "mysess",
      "--style",
      "happy",
      "--backend",
      "cli",
      "--routing",
      "volume",
    ]);

    expect(runExploration).toHaveBeenCalledTimes(1);
    const arg = runExploration.mock.calls[0][0];
    expect(arg.url).toBe("https://app.test");
    expect(arg.sessionName).toBe("mysess");
    expect(arg.sessionFile).toBeUndefined();
    expect(arg.headed).toBeUndefined();
    expect(arg.checklistText).toBeUndefined();
    expect(arg.style).toBe("happy");
    expect(typeof arg.onProgress).toBe("function");
    // --backend / --routing flow through resolveConfig into the AppConfig
    expect(arg.config.browser.backend).toBe("cli");
    expect(arg.config.roles?.worker?.provider).toBe("openrouter");
  });

  it("--fresh flows through to runExploration as fresh:true (and is falsy when absent)", async () => {
    await buildProgram().parseAsync(["node", "cairn", "explore", "--url", "https://app.test", "--fresh"]);
    expect(runExploration.mock.calls[0][0].fresh).toBe(true);

    runExploration.mockClear();
    await buildProgram().parseAsync(["node", "cairn", "explore", "--url", "https://app.test"]);
    expect(runExploration.mock.calls[0][0].fresh).toBeFalsy(); // default: dedupe against prior runs (unchanged)
  });

  it("prints the same exploration / metrics / cost / summary structure", async () => {
    await buildProgram().parseAsync(["node", "cairn", "explore", "--url", "https://app.test", "--session", "mysess"]);
    const stdout = outChunks.join("");
    const stderr = errChunks.join("");

    expect(stderr).toContain("▸ Exploring https://app.test (session: mysess)");
    expect(stdout).toContain("=== Exploration of https://app.test (run run-1) ===");
    expect(stdout).toContain("Purpose: A login page");
    expect(stdout).toContain("LLM profile: anthropic · test cases: 1");
    expect(stdout).toContain("[tc-1] (high · boundary-value) Title");
    expect(stdout).toContain("    ⇒ ok");
    expect(stdout).toContain("=== Validation: 50% green (flaky: 0) ===");
    expect(stdout).toContain("=== Metrics ===");
    expect(stdout).toContain("=== Pilot: PASS ===");
    expect(stdout).toContain("=== Cost (per role) ===");
    expect(stdout).toContain("=== Run summary ===");
    expect(stdout).toContain("Cases (ATC/MTC .md):");
    expect(stdout).toContain("Tip: to review cases BEFORE generating code, run `cairn design` then `cairn automate`.");
  });
});

describe("gated modality stubs (C1-02)", () => {
  for (const name of ["ui", "e2e", "api", "unit", "docs"]) {
    it(`cairn ${name} prints coming-soon, exits 0, and calls NO runner`, async () => {
      await buildProgram().parseAsync(["node", "cairn", name]);
      expect(outChunks.join("")).toContain("coming soon — gated (see L-G2). Build by demand, one at a time.");
      expect(runExploration).not.toHaveBeenCalled();
      expect(runDesign).not.toHaveBeenCalled();
      expect(runAutomate).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    });
  }

  it("the ui stub additionally points at today's path (cairn explore)", async () => {
    await buildProgram().parseAsync(["node", "cairn", "ui"]);
    expect(outChunks.join("")).toContain("For UI test generation today, use: cairn explore --url <url>");
  });
});

describe("CLI surface lock (C1-02)", () => {
  it("cairn --help lists the four gated stubs, marked coming-soon", () => {
    const program = buildProgram();
    program.configureHelp({ helpWidth: 80 });
    const help = program.helpInformation();
    expect(help).toContain("ui|e2e");
    expect(help).toContain("api");
    expect(help).toContain("unit");
    expect(help).toContain("docs");
    expect(help).toMatch(/coming soon|gated/i);
    expect(help).toMatchSnapshot();
  });

  it("cairn explore --help is stable (flags unchanged)", () => {
    const explore = buildProgram().commands.find((c) => c.name() === "explore");
    explore?.configureHelp({ helpWidth: 80 });
    expect(explore?.helpInformation()).toMatchSnapshot();
  });
});
