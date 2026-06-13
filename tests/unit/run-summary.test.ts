import { describe, it, expect } from "vitest";
import { renderRunSummary, classifyRunError, partialReportPayload } from "../../src/agent/summary.js";
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
});
