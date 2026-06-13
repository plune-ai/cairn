import { describe, it, expect } from "vitest";
import { finalizeFailure } from "../../src/agent/finalize.js";
import type { RunWriter } from "../../src/artifacts/index.js";
import type { CostReport } from "../../src/llm/cost.js";

const cost: CostReport = {
  perRole: [
    { role: "worker", models: ["claude-haiku-4-5"], calls: 3, inputTokens: 900, outputTokens: 100, totalTokens: 1000, costUsd: 0.005 },
  ],
  totalTokens: 1000,
  totalCostUsd: 0.005,
};

interface Capture {
  report?: Record<string, unknown>;
  md?: string;
  log?: string;
}

function captureWriter(over: Partial<RunWriter> = {}): { rw: RunWriter; store: Capture } {
  const store: Capture = {};
  const rw: RunWriter = {
    runId: "r1",
    dir: "/tmp/runs/r1",
    writeStudy: async () => undefined,
    writeSuite: async () => [],
    writeReport: async (r) => {
      store.report = r as Record<string, unknown>;
    },
    writeScreenshot: async () => undefined,
    writeAria: async () => undefined,
    writeReportMd: async (m) => {
      store.md = m;
    },
    writeLog: async (t) => {
      store.log = t;
    },
    writeTestCases: async () => [],
    ...over,
  };
  return { rw, store };
}

describe("finalizeFailure (L1-04, Box 1/3/4)", () => {
  it("writes a partial report + returns an actionable budget error pointing at the run dir", async () => {
    const { rw, store } = captureWriter();
    const lines: string[] = [];
    const err = await finalizeFailure(rw, {
      runId: "r1",
      url: "https://app.test",
      error: new Error("LLM-call budget limit reached (80 calls) — cost-guardrail."),
      cost,
      budget: { used: 80, max: 80 },
      onProgress: (e) => lines.push(e),
    });

    expect(store.report?.partial).toBe(true);
    expect(store.report?.budget).toEqual({ used: 80, max: 80 });
    expect(String(store.report?.error).toLowerCase()).toContain("budget");
    expect(store.md).toMatch(/partial/i);

    expect(err).toBeInstanceOf(Error);
    // keyword kept so the TUI error classifier still maps it to "budget"
    expect(err.message.toLowerCase()).toContain("budget");
    // actionable: tells the user where the partial results landed
    expect(err.message).toContain("/tmp/runs/r1");
    // it emitted a one-line progress message too
    expect(lines.join("\n").toLowerCase()).toContain("budget");
  });

  it("classifies a navigation failure for the thrown message", async () => {
    const { rw } = captureWriter();
    const err = await finalizeFailure(rw, {
      runId: "r1",
      url: "https://app.test",
      error: new Error("Could not reach https://app.test: navigation failed (DNS/connection)."),
    });
    expect(err.message.toLowerCase()).toMatch(/could not reach|navigation/);
  });

  it("never lets a failing artifact write mask the original failure", async () => {
    const { rw } = captureWriter({
      writeReport: async () => {
        throw new Error("disk full");
      },
    });
    const err = await finalizeFailure(rw, {
      runId: "r1",
      url: "x",
      error: new Error("page.goto: Timeout 30000ms exceeded"),
    });
    // the returned error is the friendly run error, not "disk full"
    expect(err.message).not.toMatch(/disk full/);
    expect(err.message.toLowerCase()).toMatch(/could not load|timed out|navigation/);
  });
});
