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
});
