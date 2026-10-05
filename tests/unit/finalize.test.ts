import { describe, it, expect, vi } from "vitest";
import { finalizeFailure } from "../../src/agent/finalize.js";
import type { RunWriter } from "../../src/artifacts/index.js";
import type { CostReport } from "../../src/llm/cost.js";
import { timeoutInvoke, type StructuredInvoke } from "../../src/llm/structured.js";

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

/** The error a timed-out LLM step really throws (#110) — built by `timeoutInvoke`, not typed out by hand. */
async function stepTimeoutError(label: string): Promise<Error> {
  const hangs: StructuredInvoke = () => new Promise(() => undefined); // a provider that never answers
  vi.useFakeTimers();
  try {
    const caught = timeoutInvoke(hangs, { timeoutMs: 5, label })({} as never, []).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5);
    return (await caught) as Error;
  } finally {
    vi.useRealTimers();
  }
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

  it("reports a timed-out LLM step as itself, and keeps the raw error beside the friendly one (#181)", async () => {
    const { rw, store } = captureWriter();
    const cause = await stepTimeoutError("role 'reasoner', model 'deepseek/deepseek-r1'");
    const err = await finalizeFailure(rw, { runId: "r1", url: "https://app.test", mode: "explore", error: cause });

    expect(store.report?.error).toMatch(/LLM step timed out/);
    // a wrong classification must never erase the cause: it names the step and how long it waited
    expect(store.report?.errorDetail).toBe(cause.message);
    expect(store.report?.errorDetail).toContain("role 'reasoner', model 'deepseek/deepseek-r1'");
    for (const text of [store.md, err.message]) {
      expect(text).toContain("STEP_TIMEOUT_MS");
      expect(text).not.toContain("Could not load the page");
    }
  });

  it("keeps the progress lines run.log already had and appends the summary (#181)", async () => {
    const { rw, store } = captureWriter();
    const progress = [
      "2026-10-05T10:00:00.000Z  observe — done: 12 elements, screenshot taken",
      "2026-10-05T10:00:05.000Z  identifyElements — page analysis (LLM)…",
    ];
    const logLines = [...progress];
    await finalizeFailure(rw, {
      runId: "r1",
      url: "https://app.test",
      error: new Error("something odd happened"),
      logLines,
      onProgress: (event) => logLines.push(event), // as the run's own onProgress does: the failure line joins the buffer
    });

    expect(store.log?.startsWith(progress.join("\n"))).toBe(true);
    expect(store.log).toMatch(/\n\n=== Run summary \(partial\) ===\n/);
    expect(store.log?.match(/something odd happened/g)).toHaveLength(1); // the failure line is not written twice
  });

  it("with no buffered progress the log still opens with the failure line", async () => {
    const { rw, store } = captureWriter();
    await finalizeFailure(rw, { runId: "r1", url: "https://app.test", error: new Error("something odd happened") });
    expect(store.log).toMatch(/^something odd happened\n\n=== Run summary \(partial\) ===/);
  });
});
