import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPriorRuns, unionPassedTitles, formatExperience } from "../../src/eval/collect.js";

async function writeRun(
  base: string,
  id: string,
  url: string,
  greenRatio: number,
  results: { test: string; status: string }[],
): Promise<void> {
  const d = join(base, id);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "report.json"), JSON.stringify({ url, validation: { greenRatio, results } }));
}

describe("collectPriorRuns / unionPassedTitles", () => {
  it("collects runs for the same URL, sorts by greenRatio; union of all passing", async () => {
    const base = await mkdtemp(join(tmpdir(), "qa-collect-"));
    try {
      await writeRun(base, "r1", "http://x", 0.5, [
        { test: "A", status: "passed" },
        { test: "B", status: "failed" },
      ]);
      await writeRun(base, "r2", "http://x", 0.8, [
        { test: "A", status: "passed" },
        { test: "C", status: "passed" },
      ]);
      await writeRun(base, "r3", "http://other", 1.0, [{ test: "Z", status: "passed" }]);

      const runs = await collectPriorRuns(base, "http://x");
      expect(runs.map((r) => r.runId)).toEqual(["r2", "r1"]); // best first
      expect(runs).toHaveLength(2); // the other URL is excluded
      expect(unionPassedTitles(runs).sort()).toEqual(["A", "C"]); // everything that EVER passed
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("no runs directory → []", async () => {
    expect(await collectPriorRuns(join(tmpdir(), "nope-xyz-123"), "http://x")).toEqual([]);
  });

  it("formatExperience: empty → ''; otherwise a block with the cases", () => {
    expect(formatExperience([])).toBe("");
    const txt = formatExperience(["Кейс A", "Кейс B"]);
    expect(txt).toContain("Кейс A");
    expect(txt).toContain("STABLE");
  });
});
