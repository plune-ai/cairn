import { describe, it, expect } from "vitest";
import { buildExploreGraph } from "../../src/agent/graph.js";
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

describe("buildExploreGraph (full pipeline + repair, fake deps)", () => {
  it("green on the first try → no repair (attempts 0)", async () => {
    const graph = buildExploreGraph({ ...baseDeps, validate: async () => green, maxRepair: 2 });
    const out = await graph.invoke({ url: "http://x", runId: "r1" });
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
    const graph = buildExploreGraph({ ...baseDeps, validate, maxRepair: 2 });
    const out = await graph.invoke({ url: "http://x", runId: "r1" });
    expect(out.attempts).toBe(1);
    expect(out.validation?.greenRatio).toBe(1);
    expect(calls).toBe(2);
  });

  it("persistent fail → repair up to the budget, then end (attempts = maxRepair)", async () => {
    const graph = buildExploreGraph({ ...baseDeps, validate: async () => red, maxRepair: 1 });
    const out = await graph.invoke({ url: "http://x", runId: "r1" });
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
    const graph = buildExploreGraph({
      ...baseDeps,
      gateway: partialVerify,
      designInvoke: capturingDesign,
      validate: async () => green,
      maxRepair: 0,
    });
    await graph.invoke({ url: "http://x", runId: "r1" });
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
    const graph = buildExploreGraph({ ...baseDeps, validate, maxRepair: 1 });
    const out = await graph.invoke({ url: "http://x", runId: "r1" });
    expect(out.bestValidation?.greenRatio).toBe(0.5); // keeps 0.5, does not drop to 0
    expect(out.attempts).toBe(1); // repair ran, but the best result was preserved
  });
});
