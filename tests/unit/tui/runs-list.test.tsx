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
      {
        runId: "c",
        dir: "runs/c",
        url: "https://api.example.com",
        mode: "api",
        testCaseCount: 0,
        api: { passed: 3, total: 4, endpointCount: 4 },
        date: new Date("2026-06-03T10:00:00Z"),
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
    expect(f).toContain("Past runs (3)");
    expect(f).toContain("login");
    expect(f).toContain("90%");
    expect(f).toContain("design");
    unmount();
  });

  it("C1-04/API-4 (#134): shows an api run's pass/fail + endpoint coverage instead of green%/pilot", () => {
    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi()}>
        <RunsListScreen />
      </RouterProvider>,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("api");
    expect(f).toContain("3/4 passed");
    expect(f).toContain("4 endpoint(s)");
    expect(f).toContain("api.example.com");
    unmount();
  });
});
