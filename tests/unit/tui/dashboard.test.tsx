import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

// Mock the public API so the dashboard drives a fake run — no browser/LLM.
vi.mock("../../../src/index.js", () => ({
  loadConfig: vi.fn(() => ({})),
  runExploration: vi.fn(),
  runDesign: vi.fn(),
  runAutomate: vi.fn(),
}));

import { runExploration } from "../../../src/index.js";
import { RunDashboardScreen } from "../../../src/tui/screens/run-dashboard-screen.js";
import { RouterProvider, type RouterApi } from "../../../src/tui/router-context.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `check` until it passes or the timeout elapses — robust against async/coverage timing. */
async function waitFor(check: () => void, timeout = 1500): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await delay(15);
    }
  }
}

function routerApi(over: Partial<RouterApi>): RouterApi {
  return {
    navigate: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: true,
    setInTextField: vi.fn(),
    ...over,
  };
}

describe("RunDashboardScreen", () => {
  it("renders the node checklist and routes to summary when the run resolves", async () => {
    const fakeResult = {
      runId: "x",
      runDir: "runs/x",
      study: {},
      analysis: {},
      testCases: [],
      scores: [],
    };
    vi.mocked(runExploration).mockImplementation((async (input: { onProgress?: (e: string) => void }) => {
      input.onProgress?.("observe — opening browser");
      input.onProgress?.("designTestCases — generated 5 cases");
      return fakeResult;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const replace = vi.fn();
    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi({ replace })}>
        <RunDashboardScreen
          command="explore"
          values={{ url: "https://x", style: "all", headed: false }}
        />
      </RouterProvider>,
    );

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(expect.objectContaining({ name: "summary" })),
    );
    expect(lastFrame() ?? "").toContain("Observe page"); // checklist label rendered
    unmount();
  });
});
