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
  it("pressing 'a' on an MTC case calls promoteCase", async () => {
    const { stdin, unmount } = render(<RunDetailScreen runDir="runs/x" />);
    await delay(30);
    stdin.write("a");
    await delay(40);
    expect(promoteCase).toHaveBeenCalledWith("runs/x", "MTC-DEMO-001", {});
    unmount();
  });
});
