import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { App } from "../../../src/tui/App.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("TUI navigation", () => {
  it("launcher lists the commands", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Explore");
    expect(frame).toContain("Design");
    expect(frame).toContain("Quit");
    unmount();
  });

  it("selecting the first command (Explore) opens its form on the URL step", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await delay(30); // let effects + input handlers mount
    stdin.write("\r"); // Enter on the first menu item
    await delay(80);
    expect(lastFrame() ?? "").toContain("URL");
    unmount();
  });
});
