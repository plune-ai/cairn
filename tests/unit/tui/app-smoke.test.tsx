import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { App } from "../../../src/tui/App.js";

/**
 * Foundation smoke test: proves the whole Ink + JSX(.tsx) + vitest(oxc) + ink-testing-library
 * chain works before any real screens are built. If JSX transform or Ink rendering were broken,
 * this fails first.
 */
describe("TUI App skeleton", () => {
  it("renders the cairn banner", () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toContain("Cairn");
    unmount();
  });
});
