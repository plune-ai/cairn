import { render } from "ink-testing-library";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunDetailScreen } from "../../../src/tui/screens/run-detail-screen.js";

/**
 * Regression for the "one promote per mount" bug (fix/tui-promote-multiple-per-session).
 *
 * Uses a REAL temp run dir + the REAL promoteCase + the REAL useRunArtifacts (no mocks) so the full
 * keypress → promote (rename on disk) → reload → re-render loop is exercised. The pre-fix screen set
 * a one-shot `promoted` flag on the first promote and never reset it, and the key handler closed over
 * a stale case snapshot — together they swallowed every later "a". This test promotes TWO manual
 * cases IN ONE MOUNT and asserts both persist. Promote gates poll the DISK (the persisted source of
 * truth) so the assertions don't hinge on Ink's render-flush timing.
 */

/** Minimal but valid case markdown (frontmatter promoteCase rewrites + the `# ID: title` heading). */
function caseMd(id: string, execution: "manual" | "auto"): string {
  return [
    "---",
    `id: ${id}`,
    `title: "Case ${id}"`,
    "suite: DEMO",
    "priority: P1",
    "type: functional",
    `execution: ${execution}`,
    "status: ❌ Not implemented",
    "automation: -",
    "---",
    "",
    `# ${id}: Case ${id}`,
    "",
    "## Steps",
    "",
    "1. Open the page",
    "",
    "## Expected Result",
    "",
    "- It works",
    "",
  ].join("\n");
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let runDir: string;
let tcDir: string;

async function caseCounts(): Promise<{ atc: number; mtc: number }> {
  const files = (await readdir(tcDir)).filter((f) => f.endsWith(".md"));
  return {
    atc: files.filter((f) => f.startsWith("ATC")).length,
    mtc: files.filter((f) => f.startsWith("MTC")).length,
  };
}

/** Poll the rendered frame until `predicate` holds. */
async function waitForFrame(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitForFrame timed out");
    await delay(20);
  }
}

/** Poll the persisted case files until `predicate` holds (deterministic — no render dependency). */
async function waitForDisk(
  predicate: (c: { atc: number; mtc: number }) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const counts = await caseCounts();
    if (predicate(counts)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitForDisk timed out (last: ${JSON.stringify(counts)})`);
    }
    await delay(20);
  }
}

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "cairn-promote-"));
  tcDir = join(runDir, "testcases");
  await mkdir(tcDir, { recursive: true });
  // 2 ATC + 3 MTC, matching the reproduction.
  await writeFile(join(tcDir, "ATC-DEMO-001.md"), caseMd("ATC-DEMO-001", "auto"), "utf8");
  await writeFile(join(tcDir, "ATC-DEMO-002.md"), caseMd("ATC-DEMO-002", "auto"), "utf8");
  await writeFile(join(tcDir, "MTC-DEMO-001.md"), caseMd("MTC-DEMO-001", "manual"), "utf8");
  await writeFile(join(tcDir, "MTC-DEMO-002.md"), caseMd("MTC-DEMO-002", "manual"), "utf8");
  await writeFile(join(tcDir, "MTC-DEMO-003.md"), caseMd("MTC-DEMO-003", "manual"), "utf8");
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

describe("RunDetailScreen — multiple promotes per mount", () => {
  it("promotes two manual cases in ONE session (no exit/re-enter)", async () => {
    const { lastFrame, stdin, unmount } = render(<RunDetailScreen runDir={runDir} />);
    try {
      // Cases sorted by name → [ATC-001, ATC-002, MTC-001, MTC-002, MTC-003]. Wait for load.
      await waitForFrame(() => (lastFrame() ?? "").includes("case 1/5"));

      // Navigate to the first MTC (index 2) and promote it.
      stdin.write("n");
      stdin.write("n");
      await delay(40);
      stdin.write("a");
      await waitForDisk((c) => c.atc === 3 && c.mtc === 2); // first promote persisted

      // Navigate to the next MTC and promote it — THIS is the press the bug swallowed.
      stdin.write("n");
      await delay(40);
      stdin.write("a");
      await waitForDisk((c) => c.atc === 4 && c.mtc === 1); // second promote also persisted (NOT a no-op)

      // Both manual cases are now auto on disk: 4 ATC + 1 MTC.
      expect(await caseCounts()).toEqual({ atc: 4, mtc: 1 });

      // The UI re-rendered to show the new type without exiting (the second promote's note appears).
      await waitForFrame(() => (lastFrame() ?? "").includes("Promoted MTC-DEMO-002 → ATC-DEMO-004"));
    } finally {
      unmount();
    }
  });
});
