import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/tui/hooks/use-runs.js", () => ({
  useRuns: () => ({
    runs: [
      {
        runId: "a",
        dir: "runs/a",
        url: "https://app.example.com/login",
        mode: "explore",
        greenRatio: 0.9,
        pilot: "pass",
        testCaseCount: 5,
        date: new Date("2026-06-01T10:00:00Z"),
      },
      {
        runId: "b",
        dir: "runs/b",
        url: "https://app.example.com/cart",
        mode: "design",
        testCaseCount: 8,
        date: new Date("2026-06-02T10:00:00Z"),
      },
    ],
    loading: false,
    reload: () => {},
  }),
}));

import { RunsListScreen } from "../../../src/tui/screens/runs-list-screen.js";
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

describe("RunsListScreen", () => {
  it("lists past runs with mode, green% and url", () => {
    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi()}>
        <RunsListScreen />
      </RouterProvider>,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("Past runs (2)");
    expect(f).toContain("login");
    expect(f).toContain("90%");
    expect(f).toContain("design");
    unmount();
  });
});
