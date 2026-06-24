import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import type { PageStudy } from "../../src/observe/index.js";

const study: PageStudy = {
  url: "http://x/login",
  screenshotB64: "QUJD",
  ariaYaml: "- button",
  capturedBy: "lib",
  elements: [],
};

describe("ArtifactStore", () => {
  it("openRun → writes study.json, tests/*.spec.ts, report.json, screenshot", async () => {
    const base = await mkdtemp(join(tmpdir(), "qa-art-"));
    try {
      const run = await new ArtifactStore(base).openRun("run1");
      await run.writeStudy(study);
      const written = await run.writeSuite({ files: [{ path: "login.spec.ts", content: "// test" }] });
      await run.writeReport({ greenRatio: 1 });
      await run.writeScreenshot("QUJD");
      await run.writeAria('- button "Go"');
      await run.writeReportMd("# Звіт зі селекторами");
      await run.writeLog("2026-06-08  observe…");

      expect(written).toHaveLength(1);
      expect(await readFile(join(run.dir, "snapshots", "aria.yaml"), "utf8")).toContain("button");
      expect(await readFile(join(run.dir, "report.md"), "utf8")).toContain("# Звіт");
      expect(await readFile(join(run.dir, "run.log"), "utf8")).toContain("observe");
      expect(await readFile(join(run.dir, "study.json"), "utf8")).toContain("login");
      expect(await readFile(join(run.dir, "tests", "login.spec.ts"), "utf8")).toBe("// test");
      const report = JSON.parse(await readFile(join(run.dir, "report.json"), "utf8")) as {
        greenRatio: number;
      };
      expect(report.greenRatio).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("writeSuite blocks traversal, writes normal files inside the run", async () => {
    const base = await mkdtemp(join(tmpdir(), "qa-art-"));
    try {
      const run = await new ArtifactStore(base).openRun("r");
      const written = await run.writeSuite({
        files: [
          { path: "ok.spec.ts", content: "a" },
          { path: "../escape.ts", content: "b" },
        ],
      });
      expect(written).toHaveLength(1);
      expect(written[0]?.endsWith("ok.spec.ts")).toBe(true);
      for (const p of written) expect(p.startsWith(resolve(run.dir))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("#103: writeFlowSnapshots persists per-page aria + screenshot under each page dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "qa-art-"));
    try {
      const run = await new ArtifactStore(base).openRun("rflow");
      await run.writeFlowSnapshots([
        { dir: "snapshots/0-index", ariaYaml: '- link "Home"', screenshotB64: "QUJD" },
        { dir: "snapshots/1-platform", ariaYaml: '- heading "Platform"', screenshotB64: "QUJD" },
      ]);
      // N pages → N snapshot sets, not one
      expect(await readFile(join(run.dir, "snapshots", "0-index", "aria.yaml"), "utf8")).toContain("Home");
      expect(await readFile(join(run.dir, "snapshots", "1-platform", "aria.yaml"), "utf8")).toContain("Platform");
      expect((await readFile(join(run.dir, "snapshots", "0-index", "screenshot.png"))).length).toBeGreaterThan(0);
      expect((await readFile(join(run.dir, "snapshots", "1-platform", "screenshot.png"))).length).toBeGreaterThan(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("#103: writeFlowSnapshots skips an empty screenshot and blocks traversal", async () => {
    const base = await mkdtemp(join(tmpdir(), "qa-art-"));
    try {
      const run = await new ArtifactStore(base).openRun("r2");
      await run.writeFlowSnapshots([
        { dir: "snapshots/0-x", ariaYaml: "- a", screenshotB64: "" }, // no screenshot
        { dir: "../escape", ariaYaml: "- bad", screenshotB64: "QUJD" }, // traversal → skipped
      ]);
      expect(await readFile(join(run.dir, "snapshots", "0-x", "aria.yaml"), "utf8")).toContain("a");
      await expect(readFile(join(run.dir, "snapshots", "0-x", "screenshot.png"))).rejects.toThrow();
      await expect(readFile(join(base, "escape", "aria.yaml"), "utf8")).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
