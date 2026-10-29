import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

// Mock the public API so the dashboard drives a fake run — no browser/LLM.
vi.mock("../../../src/index.js", () => ({
  loadConfig: vi.fn(() => ({})),
  resolveConfig: vi.fn(() => ({})),
  runExploration: vi.fn(),
  runDesign: vi.fn(),
  runAutomate: vi.fn(),
}));

import { runExploration, resolveConfig } from "../../../src/index.js";
import { timeoutInvoke } from "../../../src/llm/structured.js";
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
    setBackHandler: vi.fn(),
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

  it("threads the form's backend/channel/routing into resolveConfig (CLI parity)", async () => {
    vi.mocked(resolveConfig).mockClear().mockReturnValue({} as never); // calls accumulate across tests
    vi.mocked(runExploration).mockResolvedValue({
      runId: "x",
      runDir: "runs/x",
      study: {},
      analysis: {},
      testCases: [],
      scores: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const { unmount } = render(
      <RouterProvider value={routerApi({})}>
        <RunDashboardScreen
          command="explore"
          values={{ url: "https://x", style: "all", headed: false, channel: "chrome", backend: "cli", routing: "fast" }}
        />
      </RouterProvider>,
    );

    await waitFor(() => expect(resolveConfig).toHaveBeenCalled());
    expect(vi.mocked(resolveConfig).mock.calls[0]?.[0]).toMatchObject({
      channel: "chrome",
      backend: "cli",
      routing: "fast",
    });
    unmount();
  });

  it("surfaces a classified failure + recovery hint when the run throws (expired session)", async () => {
    vi.mocked(runExploration).mockImplementation((async () => {
      throw new Error("storageState is missing — session expired; recapture it");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi({})}>
        <RunDashboardScreen command="explore" values={{ url: "https://x", style: "all", headed: false }} />
      </RouterProvider>,
    );

    await waitFor(() => expect(lastFrame() ?? "").toContain("Failed: session"));
    expect(lastFrame() ?? "").toContain("recapture"); // ERROR_HINTS.session
    unmount();
  });

  it("a step past STEP_TIMEOUT_MS is its own kind, with the routing and profile advice — not a missing key (#194)", async () => {
    // The very error timeoutInvoke throws; its label names an OpenRouter model of the Anthropic family.
    const slow = timeoutInvoke(() => new Promise<never>(() => undefined), {
      timeoutMs: 1,
      label: "role 'reasoner', model 'anthropic/claude-3.5-sonnet'",
    });
    const thrown = await slow(undefined as never, []).catch((e: unknown) => e as Error);
    vi.mocked(runExploration).mockImplementation((async () => {
      throw thrown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi({})}>
        <RunDashboardScreen command="explore" values={{ url: "https://x", style: "all", headed: false }} />
      </RouterProvider>,
    );

    await waitFor(() => expect(lastFrame() ?? "").toContain("Failed: llm-timeout"));
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("--routing volume-fast");
    expect(frame).toContain("LLM_PROFILE=anthropic");
    expect(frame).toContain("STEP_TIMEOUT_MS");
    expect(frame).not.toContain("Check your API key"); // ERROR_HINTS.config
    unmount();
  });
});
