import { describe, it, expect } from "vitest";
import { renderReportMd, locatorFor } from "../../src/artifacts/report.js";
import type { ElementRef } from "../../src/browser/types.js";

const btn: ElementRef = { ref: "e6", role: "button", name: "Sign In", interactive: true, rank: 3 };

describe("locatorFor", () => {
  it("getByRole with name", () => {
    expect(locatorFor(btn)).toBe("page.getByRole('button', { name: 'Sign In' })");
  });
  it("getByRole without name", () => {
    expect(locatorFor({ ref: "e1", role: "main", interactive: false, rank: 1 })).toBe(
      "page.getByRole('main')",
    );
  });
  it("escapes apostrophes in the name", () => {
    expect(locatorFor({ ref: "e2", role: "button", name: "Кошик'ок", interactive: true, rank: 3 })).toContain(
      "Кошик\\'ок",
    );
  });
});

describe("renderReportMd", () => {
  it("contains url, selector, case, validation %", () => {
    const md = renderReportMd({
      runId: "r1",
      url: "http://x/login",
      backend: "lib",
      profile: "openrouter",
      pageSemantics: "Форма логіну",
      elements: [btn],
      testCases: [
        {
          id: "tc-1",
          title: "Логін",
          technique: "exploratory",
          preconditions: [],
          steps: ["Натиснути Sign In"],
          expected: "OK",
          priority: "high",
          elementRefs: ["e6"],
        },
      ],
      validation: { results: [{ test: "Логін", status: "passed" }], greenRatio: 1, flakyCount: 0 },
      scores: [{ name: "runs_green", value: 1 }, { name: "grounding", value: 0.75 }],
    });
    expect(md).toContain("http://x/login");
    expect(md).toContain("getByRole('button', { name: 'Sign In' })");
    expect(md).toContain("tc-1");
    expect(md).toContain("Логін");
    expect(md).toContain("100%");
    expect(md).toContain("Metrics");
    expect(md).toContain("grounding");
  });

  it("renders a per-role Cost section when cost is provided (L1-01)", () => {
    const md = renderReportMd({
      runId: "r2",
      url: "http://x/app",
      backend: "lib",
      profile: "anthropic",
      pageSemantics: "App",
      elements: [btn],
      testCases: [],
      cost: {
        perRole: [
          { role: "worker", models: ["deepseek/deepseek-chat"], calls: 2, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.001 },
          { role: "reasoner", models: ["claude-opus-4-8"], calls: 1, inputTokens: 800, outputTokens: 400, totalTokens: 1200, costUsd: 0.014 },
        ],
        totalTokens: 2700,
        totalCostUsd: 0.015,
      },
    });
    expect(md).toContain("Cost (per role)");
    expect(md).toContain("worker");
    expect(md).toContain("reasoner");
    expect(md).toContain("deepseek/deepseek-chat");
    expect(md).toContain("$0.0140");
    expect(md).toContain("$0.0150"); // total
  });

  it("renders '—' for an unknown (null) cost without crashing", () => {
    const md = renderReportMd({
      runId: "r3",
      url: "http://x/app",
      backend: "lib",
      profile: "openrouter",
      pageSemantics: "App",
      elements: [],
      testCases: [],
      cost: {
        perRole: [{ role: "worker", models: ["mystery"], calls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null }],
        totalTokens: 15,
        totalCostUsd: null,
      },
    });
    expect(md).toContain("Cost (per role)");
    expect(md).toMatch(/\bworker\b.*—/);
  });
});
