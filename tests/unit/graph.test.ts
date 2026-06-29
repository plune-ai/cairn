import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExploreGraph } from "../../src/agent/graph.js";
import { InteractionMapSchema } from "../../src/documentarian/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { BrowserGateway } from "../../src/browser/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { RunWriter } from "../../src/artifacts/index.js";
import type { ValidationReport } from "../../src/validate/index.js";

const fakeGateway: BrowserGateway = {
  observe: async () => ({
    url: "http://x",
    screenshotB64: "",
    ariaSnapshot: '- button "Go"',
    capturedBy: "lib",
  }),
  act: async () => ({ ok: true }),
  verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
  getState: async () => ({ visible: true, enabled: true }),
  session: () => ({ load: async () => undefined, save: async () => ({ cookies: [], origins: [] }) }),
  runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
  close: async () => undefined,
};

const analyzeInvoke: StructuredInvoke = async (schema) =>
  schema.parse({ pageSemantics: "Сторінка", primaryRefs: ["e1"] });
const designInvoke: StructuredInvoke = async (schema) =>
  schema.parse({
    testCases: [
      {
        title: "Кейс",
        technique: "exploratory",
        preconditions: [],
        steps: ["крок"],
        expected: "очік",
        priority: "high",
        elementRefs: ["e1"],
      },
    ],
  });
const codegenInvoke: StructuredInvoke = async (schema) =>
  schema.parse({
    files: [
      { path: "x.spec.ts", content: "import { test } from '@playwright/test';\ntest('t', async () => {});" },
    ],
  });

const fakeRunWriter: RunWriter = {
  runId: "r1",
  dir: "/tmp/runtest",
  writeStudy: async () => undefined,
  writeSuite: async () => [],
  writeReport: async () => undefined,
  writeScreenshot: async () => undefined,
};

const baseDeps = {
  gateway: fakeGateway,
  prompts: new PromptRegistry(),
  analyzeInvoke,
  designInvoke,
  codegenInvoke,
  useVision: false,
  runWriter: fakeRunWriter,
};

const green: ValidationReport = { results: [{ test: "t", status: "passed" }], greenRatio: 1, flakyCount: 0 };
const red: ValidationReport = { results: [{ test: "t", status: "failed" }], greenRatio: 0, flakyCount: 0 };

describe("runExploreGraph (full pipeline + repair, fake deps)", () => {
  it("green on the first try → no repair (attempts 0)", async () => {
    const out = await runExploreGraph({ ...baseDeps, validate: async () => green, maxRepair: 2 }, { url: "http://x", runId: "r1" });
    expect(out.suite).toBeDefined();
    expect(out.validation?.greenRatio).toBe(1);
    expect(out.attempts).toBe(0);
  });

  it("fail → repair → green (attempts 1, validate called twice)", async () => {
    let calls = 0;
    const validate = async (): Promise<ValidationReport> => {
      calls += 1;
      return calls === 1 ? red : green;
    };
    const out = await runExploreGraph({ ...baseDeps, validate, maxRepair: 2 }, { url: "http://x", runId: "r1" });
    expect(out.attempts).toBe(1);
    expect(out.validation?.greenRatio).toBe(1);
    expect(calls).toBe(2);
  });

  it("persistent fail → repair up to the budget, then end (attempts = maxRepair)", async () => {
    const out = await runExploreGraph({ ...baseDeps, validate: async () => red, maxRepair: 1 }, { url: "http://x", runId: "r1" });
    expect(out.attempts).toBe(1);
    expect(out.validation?.greenRatio).toBe(0);
  });

  it("verifyLocators → design receives count≥1 (incl. repeated ×N); not-found are excluded", async () => {
    let designPrompt = "";
    const capturingDesign: StructuredInvoke = async (schema, messages) => {
      designPrompt = JSON.stringify(messages);
      return schema.parse({ testCases: [] });
    };
    const partialVerify: BrowserGateway = {
      ...fakeGateway,
      observe: async () => ({
        url: "http://x",
        screenshotB64: "",
        ariaSnapshot: '- button "Go"\n- link "Bad"\n- button "Ghost"',
        capturedBy: "lib",
      }),
      // Go=1 (unique), Bad=2 (repeated → .first()), Ghost=0 (not found → exclude).
      verify: async (els) =>
        els.map((e) => ({
          ...e,
          count: e.name === "Go" ? 1 : e.name === "Bad" ? 2 : 0,
          verified: e.name === "Go",
        })),
    };
    await runExploreGraph(
      {
        ...baseDeps,
        gateway: partialVerify,
        designInvoke: capturingDesign,
        validate: async () => green,
        maxRepair: 0,
      },
      { url: "http://x", runId: "r1" },
    );
    expect(designPrompt).toContain("Go");
    expect(designPrompt).toContain("Bad"); // count>1 → included as repeated (.first())
    expect(designPrompt).toContain("×2"); // repetition annotation
    expect(designPrompt).not.toContain("Ghost"); // count 0 (not found) → excluded
  });

  it("keep-best: a worse/0-test regeneration is NOT accepted — keeps the best", async () => {
    let calls = 0;
    const validate = async (): Promise<ValidationReport> => {
      calls += 1;
      return calls === 1
        ? {
            results: [
              { test: "a", status: "passed" },
              { test: "b", status: "failed" },
            ],
            greenRatio: 0.5,
            flakyCount: 0,
          }
        : { results: [], greenRatio: 0, flakyCount: 0 }; // broken regeneration (0 tests) — worse
    };
    const out = await runExploreGraph({ ...baseDeps, validate, maxRepair: 1 }, { url: "http://x", runId: "r1" });
    expect(out.bestValidation?.greenRatio).toBe(0.5); // keeps 0.5, does not drop to 0
    expect(out.attempts).toBe(1); // repair ran, but the best result was preserved
  });
});

describe("documentarian cache reuse (#93)", () => {
  const countingAnalyze = (counter: { n: number }): StructuredInvoke => async (schema) => {
    counter.n += 1;
    return schema.parse({ pageSemantics: "Сторінка", primaryRefs: ["e1"] });
  };

  it("run 1 emits a valid-schema understanding artifact; run 2 on the same page reuses it (fewer ground calls)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-graph-doc-"));
    try {
      const c = { n: 0 };
      let emitted: unknown;
      const deps = {
        ...baseDeps,
        analyzeInvoke: countingAnalyze(c),
        understandingCacheDir: dir,
        onUnderstanding: (m: unknown) => {
          emitted = m;
        },
        validate: async () => green,
        maxRepair: 0,
      };
      await runExploreGraph(deps, { url: "http://x", runId: "r1" });
      expect(c.n).toBe(1); // cold cache → grounded once
      expect(InteractionMapSchema.safeParse(emitted).success).toBe(true); // DoD (a): valid artifact emitted

      await runExploreGraph(deps, { url: "http://x", runId: "r2" });
      expect(c.n).toBe(1); // DoD (b): same page → cache HIT, NO extra ground LLM call
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a changed page (different ARIA) invalidates the cache → grounds again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-graph-doc2-"));
    try {
      const c = { n: 0 };
      const gwChanged: BrowserGateway = {
        ...fakeGateway,
        observe: async () => ({ url: "http://x", screenshotB64: "", ariaSnapshot: '- button "Changed"', capturedBy: "lib" }),
      };
      const base = { ...baseDeps, analyzeInvoke: countingAnalyze(c), understandingCacheDir: dir, validate: async () => green, maxRepair: 0 };
      await runExploreGraph(base, { url: "http://x", runId: "r1" });
      await runExploreGraph({ ...base, gateway: gwChanged }, { url: "http://x", runId: "r2" });
      expect(c.n).toBe(2); // DoD (c): page changed → re-grounded
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fresh:true bypasses a present cache → grounds anyway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-graph-doc3-"));
    try {
      const c = { n: 0 };
      const base = { ...baseDeps, analyzeInvoke: countingAnalyze(c), understandingCacheDir: dir, validate: async () => green, maxRepair: 0 };
      await runExploreGraph(base, { url: "http://x", runId: "r1" });
      await runExploreGraph({ ...base, fresh: true }, { url: "http://x", runId: "r2" });
      expect(c.n).toBe(2); // fresh ignored the hit
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no cache dir → documentarian is off, behavior unchanged (grounds every run)", async () => {
    const c = { n: 0 };
    const base = { ...baseDeps, analyzeInvoke: countingAnalyze(c), validate: async () => green, maxRepair: 0 };
    await runExploreGraph(base, { url: "http://x", runId: "r1" });
    await runExploreGraph(base, { url: "http://x", runId: "r2" });
    expect(c.n).toBe(2); // no caching → back-compat
  });
});

describe("expired-session fail-fast (expectAuthenticated, L1-05)", () => {
  const loginAnalyze: StructuredInvoke = async (schema) =>
    schema.parse({ pageSemantics: "Sign in to continue", primaryRefs: ["e1"] });

  it("session supplied + first page looks like login → rejects with re-capture guidance (names the session)", async () => {
    const sessionDeps = {
      ...baseDeps,
      analyzeInvoke: loginAnalyze,
      expectAuthenticated: true,
      sessionName: "myapp",
      validate: async () => green,
      maxRepair: 0,
    };
    await expect(runExploreGraph(sessionDeps, { url: "http://x", runId: "r1" })).rejects.toThrow(
      /cairn session capture/,
    );
    await expect(runExploreGraph(sessionDeps, { url: "http://x", runId: "r1" })).rejects.toThrow(/myapp/);
  });

  it("fail-fast happens BEFORE design/codegen (no test cases or suite produced)", async () => {
    let designed = false;
    await expect(
      runExploreGraph(
        {
          ...baseDeps,
          analyzeInvoke: loginAnalyze,
          designInvoke: async (schema) => {
            designed = true;
            return schema.parse({ testCases: [] });
          },
          expectAuthenticated: true,
          validate: async () => green,
          maxRepair: 0,
        },
        { url: "http://x", runId: "r1" },
      ),
    ).rejects.toThrow();
    expect(designed).toBe(false); // never reached designTestCases
  });

  it("login-looking page but NO session supplied → no throw (exploring a public login page is allowed)", async () => {
    const out = await runExploreGraph(
      {
        ...baseDeps,
        analyzeInvoke: loginAnalyze,
        validate: async () => green,
        maxRepair: 0,
      },
      { url: "http://x", runId: "r1" },
    );
    expect(out.analysis?.pageSemantics).toContain("Sign in");
  });

  it("session supplied but a real app page → no throw", async () => {
    const out = await runExploreGraph(
      {
        ...baseDeps,
        expectAuthenticated: true,
        sessionName: "myapp",
        validate: async () => green,
        maxRepair: 0,
      },
      { url: "http://x", runId: "r1" },
    );
    expect(out.suite).toBeDefined();
  });
});
