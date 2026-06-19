import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/tui/hooks/use-sessions.js", () => ({
  useSessions: () => ({ names: [], loading: false }),
}));

import { FormScreen } from "../../../src/tui/screens/form-screen.js";
import { RouterProvider, type RouterApi } from "../../../src/tui/router-context.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function routerApi(over: Partial<RouterApi> = {}): RouterApi {
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

describe("FormScreen", () => {
  it("starts on the URL text step and flags a focused text field", async () => {
    const setInTextField = vi.fn();
    const { lastFrame, unmount } = render(
      <RouterProvider value={routerApi({ setInTextField })}>
        <FormScreen command="design" />
      </RouterProvider>,
    );
    await delay(40);
    expect(lastFrame() ?? "").toContain("URL");
    expect(setInTextField).toHaveBeenCalledWith(true); // a text field owns the keyboard on the URL step
    unmount();
  });

  it("walks the wizard to the submit step and starts the run (navigates to the dashboard)", async () => {
    const navigate = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <RouterProvider value={routerApi({ navigate })}>
        <FormScreen command="design" />
      </RouterProvider>,
    );
    await delay(40);
    // design steps: url → session → checklist → style → fresh → headed → backend → channel → routing → submit
    stdin.write("https://app.test");
    await delay(20);
    stdin.write("\r"); // url → session
    await delay(50);
    stdin.write("\r"); // session: (no session) → checklist
    await delay(50);
    stdin.write("\r"); // checklist: empty → style
    await delay(50);
    stdin.write("\r"); // style: highlighted "all" → fresh
    await delay(50);
    stdin.write("\r"); // fresh: highlighted "no" → headed
    await delay(50);
    stdin.write("\r"); // headed: highlighted "no" → backend
    await delay(50);
    expect(lastFrame() ?? "").toContain("Browser backend"); // new CLI-parity config step
    stdin.write("\r"); // backend: (default) → channel
    await delay(50);
    stdin.write("\r"); // channel: (default) → routing
    await delay(50);
    stdin.write("\r"); // routing: (default) → submit
    await delay(50);
    expect(lastFrame() ?? "").toContain("Ready to run");
    stdin.write("\r"); // submit → start the run
    await delay(50);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ name: "dashboard", command: "design" }));
    unmount();
  });
});
