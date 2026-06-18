import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { LauncherScreen } from "../../../src/tui/screens/launcher-screen.js";
import { RouterProvider, type RouterApi } from "../../../src/tui/router-context.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function routerApi(over: Partial<RouterApi> = {}): RouterApi {
  return {
    navigate: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: false,
    setInTextField: vi.fn(),
    setBackHandler: vi.fn(),
    ...over,
  };
}

// ink-select-input moves with j/k as well as the arrow keys — j is a plain char (no escape sequence),
// so menu navigation in tests is deterministic.
describe("LauncherScreen", () => {
  it("opens the Explore form on the first item", async () => {
    const navigate = vi.fn();
    const { stdin, unmount } = render(
      <RouterProvider value={routerApi({ navigate })}>
        <LauncherScreen />
      </RouterProvider>,
    );
    await delay(30);
    stdin.write("\r");
    await delay(30);
    expect(navigate).toHaveBeenCalledWith({ name: "form", command: "explore" });
    unmount();
  });

  it("opens the Design form one step down", async () => {
    const navigate = vi.fn();
    const { stdin, unmount } = render(
      <RouterProvider value={routerApi({ navigate })}>
        <LauncherScreen />
      </RouterProvider>,
    );
    await delay(30);
    stdin.write("j"); // → Design
    await delay(20);
    stdin.write("\r");
    await delay(30);
    expect(navigate).toHaveBeenCalledWith({ name: "form", command: "design" });
    unmount();
  });

  it("opens the past-runs browser (Browse past runs)", async () => {
    const navigate = vi.fn();
    const { stdin, unmount } = render(
      <RouterProvider value={routerApi({ navigate })}>
        <LauncherScreen />
      </RouterProvider>,
    );
    await delay(30);
    stdin.write("j"); // → Design
    await delay(20);
    stdin.write("j"); // → Automate
    await delay(20);
    stdin.write("j"); // → Browse past runs
    await delay(20);
    stdin.write("\r");
    await delay(30);
    expect(navigate).toHaveBeenCalledWith({ name: "runsList" });
    unmount();
  });
});
