import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { SummaryScreen } from "../../../src/tui/screens/summary-screen.js";
import { RouterProvider, type RouterApi } from "../../../src/tui/router-context.js";

function routerApi(): RouterApi {
  return {
    navigate: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: true,
    setInTextField: vi.fn(),
    setBackHandler: vi.fn(),
  };
}

describe("SummaryScreen", () => {
  it("renders green%, pilot, scores and cases from a typed ExploreResult", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {
      runId: "r",
      runDir: "runs/r",
      testCases: [{ id: "tc-1", title: "Login valid", execution: "auto", priority: "high" }],
      validation: { results: [], greenRatio: 0.85, flakyCount: 1 },
      scores: [{ name: "grounding", value: 1 }],
      pilot: { verdict: "pass", reason: "stable", guidance: "ship it" },
    };
    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi()}>
        <SummaryScreen command="explore" result={result} />
      </RouterProvider>,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("85% green");
    expect(f).toContain("PASS");
    expect(f).toContain("grounding");
    expect(f).toContain("Login valid");
    unmount();
  });

  it("an automate result lists what the decider kept out of repair and every locator it healed (ADR-0022)", () => {
    // automate writes no report: the summary is the only place the TUI shows them
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {
      runDir: "runs/r",
      specFiles: ["a.spec.ts"],
      validation: { results: [], greenRatio: 1, flakyCount: 0 },
      notRepaired: [{ test: "tc-2: checkout", category: "app-bug", confidence: 0.91, exclude: true }],
      healed: [{ test: "tc-1: signs in", from: "getByRole('button', { name: 'Log in' })", to: "getByRole('button', { name: 'Sign In', exact: true })", confidence: 0.93 }],
    };
    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi()}>
        <SummaryScreen command="automate" result={result} />
      </RouterProvider>,
    );
    const f = (lastFrame() ?? "").replace(/\s+/g, " "); // ink wraps long lines
    expect(f).toContain("Not repaired — likely an app bug or a broken environment:");
    expect(f).toContain("tc-2: checkout — app-bug (confidence 0.91)");
    expect(f).toContain("Locators healed — offered to the repair, matched exactly once on the page:");
    expect(f).toContain(
      "tc-1: signs in: getByRole('button', { name: 'Log in' }) → getByRole('button', { name: 'Sign In', exact: true }) (confidence 0.93)",
    );
    unmount();
  });
});
