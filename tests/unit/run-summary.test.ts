import { describe, it, expect, vi } from "vitest";
import { renderRunSummary, classifyRunError, partialReportPayload, displayPath } from "../../src/agent/summary.js";
import { timeoutInvoke, type StructuredInvoke } from "../../src/llm/structured.js";
import type { ValidationReport } from "../../src/validate/index.js";
import type { CostReport } from "../../src/llm/cost.js";

const validation: ValidationReport = {
  results: [
    { test: "loads", status: "passed" },
    { test: "submits", status: "passed" },
    { test: "rejects empty", status: "failed" },
  ],
  greenRatio: 2 / 3,
  flakyCount: 0,
};

const cost: CostReport = {
  perRole: [
    { role: "worker", models: ["claude-haiku-4-5"], calls: 4, inputTokens: 1000, outputTokens: 234, totalTokens: 1234, costUsd: 0.0123 },
  ],
  totalTokens: 1234,
  totalCostUsd: 0.0123,
};

describe("renderRunSummary (L1-04, Box 4 — first-run UX)", () => {
  it("contains pass/fail counts, cost+tokens, budget used, and the artifact path", () => {
    const text = renderRunSummary({
      runDir: "/tmp/runs/abc123",
      validation,
      cost,
      budget: { used: 8, max: 80 },
    }).join("\n");

    expect(text).toContain("/tmp/runs/abc123"); // artifact path
    expect(text).toMatch(/2 passed/); // pass count
    expect(text).toMatch(/1 failed/); // fail count
    expect(text).toMatch(/1234/); // tokens
    expect(text).toMatch(/\$0\.0123/); // cost
    expect(text).toMatch(/8\s*\/\s*80/); // budget used / max
  });

  it("#94: links the screencasts dir when scenarios were recorded, and omits it otherwise", () => {
    const recorded = renderRunSummary({
      runDir: "/tmp/runs/abc123",
      validation: { ...validation, screencasts: [{ test: "loads", video: "screencasts/loads/video.webm", chapters: [] }] },
    }).join("\n");
    expect(recorded).toMatch(/Screencasts:\s*1 \.webm recorded/);
    expect(recorded).toContain("/tmp/runs/abc123/screencasts/");

    // default run (no screencasts) — no Screencasts line, no regression
    const plain = renderRunSummary({ runDir: "/tmp/runs/abc123", validation }).join("\n");
    expect(plain).not.toMatch(/Screencasts:/);
  });

  it("renders unknown cost gracefully (some prices missing)", () => {
    const text = renderRunSummary({
      runDir: "/x",
      cost: { perRole: [], totalTokens: 500, totalCostUsd: null },
      budget: { used: 1, max: 80 },
    }).join("\n");
    expect(text).toMatch(/500/);
    expect(text).not.toMatch(/\$NaN/);
  });

  it("marks a partial run and surfaces the note", () => {
    const text = renderRunSummary({
      runDir: "/tmp/runs/x",
      partial: true,
      budget: { used: 80, max: 80 },
      note: "call budget reached — partial results saved",
    }).join("\n");
    expect(text).toMatch(/partial/i);
    expect(text).toContain("call budget reached — partial results saved");
  });

  it("flags an early stop (no progress)", () => {
    const text = renderRunSummary({ runDir: "/x", stoppedEarly: true, validation }).join("\n");
    expect(text).toMatch(/stopped early|no progress/i);
  });

  it("never shows a negative remaining budget", () => {
    const text = renderRunSummary({ runDir: "/x", budget: { used: 85, max: 80 } }).join("\n");
    expect(text).not.toMatch(/-\d/);
  });

  it("C1-04/API-4 (#134): renders api run pass/fail, endpoint coverage, and the evidence path", () => {
    const text = renderRunSummary({
      runDir: "/tmp/runs/api-1",
      api: { passed: 3, total: 4, endpointCount: 4, evidencePath: "/tmp/runs/api-1/api-evidence.json" },
    }).join("\n");
    expect(text).toMatch(/3\/4 passed/);
    expect(text).toMatch(/4 endpoint\(s\) covered/);
    expect(text).toContain("Evidence:  /tmp/runs/api-1/api-evidence.json");
  });
});

describe("classifyRunError (L1-04, Box 1/3 — friendly, actionable)", () => {
  it("classifies a navigation failure", () => {
    const info = classifyRunError(new Error("page.goto: Timeout 30000ms exceeded"), { runDir: "runs/abc" });
    expect(info.kind).toBe("navigation");
    expect(info.line).toBeTruthy();
  });

  it("classifies a budget trip and points at the saved partial results", () => {
    const info = classifyRunError(new Error("LLM-call budget limit reached (80 calls)"), { runDir: "runs/abc" });
    expect(info.kind).toBe("budget");
    // keyword preserved so the TUI error classifier still maps it to "budget"
    expect(info.line.toLowerCase()).toContain("budget");
    // actionable: tells the user where the partial results landed
    expect(info.hint).toContain("runs/abc");
  });

  it("classifies an expired/missing session", () => {
    const info = classifyRunError(new Error("Session looks expired — re-capture it"), {});
    expect(info.kind).toBe("session");
    expect(info.line.toLowerCase()).toMatch(/session|expired|login/);
  });

  it("classifies a missing API key as config", () => {
    expect(classifyRunError(new Error("ANTHROPIC_API_KEY is required")).kind).toBe("config");
  });

  it("falls back to unknown with a readable single line (no stack)", () => {
    const info = classifyRunError(new Error("something odd happened"));
    expect(info.kind).toBe("unknown");
    expect(info.line.split("\n").length).toBe(1);
  });
});

/** The error a timed-out LLM step really throws (#110) — built by `timeoutInvoke`, not typed out by hand. */
async function stepTimeoutError(label?: string): Promise<Error> {
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

describe("classifyRunError — a timed-out LLM step is not a page that could not load (#181)", () => {
  it.each([["role 'reasoner', model 'deepseek/deepseek-r1'"], [undefined]])(
    "files the step timeout under its own kind, with the advice that applies (label %j)",
    async (label) => {
      const err = await stepTimeoutError(label);
      const info = classifyRunError(err, { runDir: "runs/abc" });
      expect(info.kind).toBe("llm-timeout");
      expect(info.line).toMatch(/LLM step timed out/);
      expect(info.hint).toContain("--routing");
      expect(info.hint).toContain("STEP_TIMEOUT_MS");
      expect(info.hint).toContain("runs/abc"); // where the partial results are, as for every kind
      expect(`${info.line} ${info.hint}`).not.toMatch(/page|URL/i); // none of the page advice it used to get
      expect(info.detail).toBe(err.message); // the raw cause stays available
    },
  );

  it.each([
    "page.goto: Timeout 30000ms exceeded.",
    "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/",
    "net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/",
    "Navigation timeout of 30000 ms exceeded",
  ])("still files %j under navigation", (message) => {
    expect(classifyRunError(new Error(message), { runDir: "runs/abc" })).toMatchObject({
      kind: "navigation",
      line: "Could not load the page (navigation failed or timed out).",
      hint: "Check the URL is correct and reachable, then try again. Partial results saved to runs/abc.",
    });
  });

  it.each([
    "LLM-call budget limit reached (80 calls)", // budget
    "Session looks expired — re-capture it", // session
    "Invalid API key provided", // config
    "page.goto: Timeout 30000ms exceeded.", // navigation
    "something odd happened", // unknown
  ])("keeps the first line of %j as `detail`, under whatever kind it is filed", (message) => {
    expect(classifyRunError(new Error(`${message}\n    at navigate (pw.js:1:1)`)).detail).toBe(message);
  });
});

describe("displayPath — cross-platform path display (console)", () => {
  it("normalizes Windows backslashes to forward slashes", () => {
    expect(displayPath("runs\\abc123\\testcases")).toBe("runs/abc123/testcases");
    expect(displayPath("C:\\proj\\runs\\x")).toBe("C:/proj/runs/x");
  });

  it("leaves POSIX paths unchanged", () => {
    expect(displayPath("runs/abc/testcases")).toBe("runs/abc/testcases");
  });

  it("renderRunSummary shows the artifact path with forward slashes, even from a Windows-style runDir", () => {
    const text = renderRunSummary({ runDir: "C:\\proj\\runs\\abc" }).join("\n");
    expect(text).toContain("Artifacts: C:/proj/runs/abc");
    expect(text).not.toContain("\\");
  });

  it("classifyRunError normalizes the partial-results path in the hint", () => {
    const info = classifyRunError(new Error("something odd"), { runDir: "runs\\abc" });
    expect(info.hint).toContain("runs/abc");
    expect(info.hint).not.toContain("\\");
  });
});

describe("partialReportPayload (L1-04, Box 1/3)", () => {
  it("marks the report partial and carries the error, cost and budget", () => {
    const p = partialReportPayload({
      runId: "r1",
      url: "https://app.test",
      error: "could not load the page",
      cost,
      budget: { used: 80, max: 80 },
    });
    expect(p.partial).toBe(true);
    expect(p.runId).toBe("r1");
    expect(p.url).toBe("https://app.test");
    expect(String(p.error)).toContain("could not load");
    expect(p.budget).toEqual({ used: 80, max: 80 });
    expect(p.cost).toBe(cost);
  });

  it("keeps the error's own first line beside the friendly one, when there is one (#181)", () => {
    const base = { runId: "r1", url: "https://app.test", error: "An LLM step timed out" };
    expect(partialReportPayload({ ...base, errorDetail: "LLM step timed out after 240000ms" })).toMatchObject({
      error: "An LLM step timed out",
      errorDetail: "LLM step timed out after 240000ms",
    });
    expect(partialReportPayload(base)).not.toHaveProperty("errorDetail");
  });
});
