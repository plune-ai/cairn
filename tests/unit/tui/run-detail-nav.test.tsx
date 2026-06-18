import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

// Stub the filesystem-backed hooks so launcher → runsList → runDetail is deterministic.
vi.mock("../../../src/tui/hooks/use-runs.js", () => ({
  useRuns: () => ({
    runs: [
      {
        runId: "a",
        dir: "runs/a",
        url: "https://app.example.com/login",
        mode: "design",
        testCaseCount: 1,
        date: new Date("2026-06-01T10:00:00Z"),
      },
    ],
    loading: false,
    reload: () => {},
  }),
}));
vi.mock("../../../src/tui/hooks/use-run-artifacts.js", () => ({
  useRunArtifacts: () => ({ cases: [], report: "r", log: "l", loading: false, reload: () => {} }),
}));

import { App } from "../../../src/tui/App.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);

describe("TUI run-detail navigation", () => {
  it("Escape on the run detail pops exactly ONE level (back to the runs list, not the launcher)", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await delay(30);
    // launcher → "Browse past runs" is the 4th item (j moves down; j is a plain key in ink-select-input).
    stdin.write("j");
    await delay(20);
    stdin.write("j");
    await delay(20);
    stdin.write("j");
    await delay(20);
    stdin.write("\r"); // → runs list
    await delay(80);
    expect(lastFrame() ?? "").toContain("Past runs");

    stdin.write("\r"); // select the first run → run detail
    await delay(80);
    expect(lastFrame() ?? "").toContain("Cases"); // the tabbed artifact viewer

    stdin.write(ESC); // back
    await delay(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Past runs"); // ONE pop → runs list
    expect(frame).not.toContain("pick a command"); // NOT the launcher (would be a double pop)
    unmount();
  });
});
