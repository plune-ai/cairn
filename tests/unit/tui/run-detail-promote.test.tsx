import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

const { promoteCase } = vi.hoisted(() => ({
  promoteCase: vi.fn(async () => ({
    oldId: "MTC-DEMO-001",
    newId: "ATC-DEMO-003",
    oldFile: "",
    newFile: "",
    selectorsFilled: 1,
    missingRefs: [],
  })),
}));

vi.mock("../../../src/promote/index.js", () => ({ promoteCase }));

vi.mock("../../../src/tui/hooks/use-run-artifacts.js", () => ({
  useRunArtifacts: () => ({
    cases: [{ name: "MTC-DEMO-001.md", text: "---\nid: MTC-DEMO-001\n---\n# x" }],
    report: "r",
    log: "l",
    loading: false,
  }),
}));

import { RunDetailScreen } from "../../../src/tui/screens/run-detail-screen.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RunDetailScreen promote", () => {
  it("pressing 'a' on an MTC case calls promoteCase and shows success note", async () => {
    const { lastFrame, stdin, unmount } = render(<RunDetailScreen runDir="runs/x" />);
    await delay(30);
    stdin.write("a");
    await delay(40);
    expect(promoteCase).toHaveBeenCalledWith("runs/x", "MTC-DEMO-001", {});
    expect(lastFrame() ?? "").toContain("Promoted MTC-DEMO-001 → ATC-DEMO-003");
    unmount();
  });

  it("shows a failure note when promote rejects", async () => {
    promoteCase.mockRejectedValueOnce(new Error("disk error"));
    const { lastFrame, stdin, unmount } = render(<RunDetailScreen runDir="runs/x" />);
    await delay(30);
    stdin.write("a");
    await delay(40);
    expect(lastFrame() ?? "").toContain("Promote failed: disk error");
    unmount();
  });
});
