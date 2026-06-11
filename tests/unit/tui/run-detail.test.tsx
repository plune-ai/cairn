import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/tui/hooks/use-run-artifacts.js", () => ({
  useRunArtifacts: () => ({
    cases: [{ name: "ATC-login-001.md", text: "# Login valid\n1. open\n2. submit" }],
    report: "# Report\n85% green",
    log: "observe — done",
    loading: false,
  }),
}));

import { RunDetailScreen } from "../../../src/tui/screens/run-detail-screen.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RunDetailScreen", () => {
  it("shows numbered tabs and the active (cases) content", () => {
    const { lastFrame, unmount } = render(<RunDetailScreen runDir="runs/x" />);
    const f = lastFrame() ?? "";
    expect(f).toContain("1 Cases");
    expect(f).toContain("2 Report");
    expect(f).toContain("3 Logs");
    expect(f).toContain("ATC-login-001.md"); // case header visible
    unmount();
  });

  it("switches to the Report tab when '2' is pressed", async () => {
    const { lastFrame, stdin, unmount } = render(<RunDetailScreen runDir="runs/x" />);
    await delay(20);
    stdin.write("2");
    await delay(40);
    expect(lastFrame() ?? "").toContain("85% green");
    unmount();
  });
});
