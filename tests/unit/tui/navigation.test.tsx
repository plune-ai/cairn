import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

// The session step renders a SelectInput backed by useSessions (reads .auth/). Stub it so the
// wizard advances deterministically in tests without touching the filesystem.
vi.mock("../../../src/tui/hooks/use-sessions.js", () => ({
  useSessions: () => ({ names: [], loading: false }),
}));

import { App } from "../../../src/tui/App.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27); // 0x1B — the Escape key byte

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

describe("TUI Escape / exit", () => {
  it("Escape on the first (URL) step leaves the form for the launcher", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await delay(30);
    stdin.write("\r"); // launcher → Explore form (URL step)
    await delay(80);
    expect(lastFrame() ?? "").toContain("URL");
    stdin.write(ESC);
    await delay(80);
    expect(lastFrame() ?? "").toContain("Quit"); // back at the launcher menu
    unmount();
  });

  it("Escape on a later step steps back through the wizard (does not exit to the launcher)", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await delay(30);
    stdin.write("\r"); // Explore form, URL step
    await delay(80);
    stdin.write("https://example.test"); // fill the URL
    await delay(30);
    stdin.write("\r"); // advance → session step
    await delay(80);
    expect(lastFrame() ?? "").toContain("Session");
    stdin.write(ESC); // step back
    await delay(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("URL"); // back on the URL step
    expect(frame).not.toContain("Quit"); // NOT the launcher
    unmount();
  });
});
