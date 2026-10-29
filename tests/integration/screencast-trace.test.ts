import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { runSpecs, type ScreencastEntry } from "../../src/validate/runner.js";
import { validateSuite } from "../../src/validate/index.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const BASE = join(process.cwd(), "runs", ".itest-screencast-trace");

const SHOP = {
  path: "shop.spec.ts",
  content: `import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await test.step('open the shop', async () => {
    await page.setContent('<h1>Shop</h1><p id="n">0</p>');
  });
});
test('shop', async ({ page }) => {
  await test.step('add an item', async () => {
    await test.step('press add', async () => {
      await page.locator('#n').evaluate((el) => { el.textContent = '1'; });
    });
  });
  await test.step('see it added', async () => {
    await expect(page.locator('#n')).toHaveText('1');
    // A frame reaches the trace only once the page paints: a scenario of a few ms ends before it, keeping estimates.
    await page.waitForTimeout(500);
  });
});`,
};

describe("#214 screencast chapters from a real Playwright trace", () => {
  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
  });
  afterAll(async () => {
    await rm(BASE, { recursive: true, force: true });
  });

  it("takes the offsets from the trace; a step inside a hook and a nested step are not chapters", async () => {
    const run = await new ArtifactStore(BASE).openRun("trace");
    await run.writeSuite({ files: [SHOP] });

    const screencastDir = join(run.dir, "screencasts");
    const results = await runSpecs(run.dir, { screencastDir, workers: 1 });
    expect(results.map((r) => r.status)).toEqual(["passed"]);

    const [entry] = JSON.parse(await readFile(join(screencastDir, "screencasts.json"), "utf8")) as ScreencastEntry[];
    expect(entry!.trace).toMatch(/^screencasts\/.+\/trace\.zip$/);
    expect((await stat(join(run.dir, entry!.trace!))).size).toBeGreaterThan(0);
    // The real archive (data descriptors, sizes only in the central directory) was read, and its steps matched.
    expect(entry!.timing).toBe("trace");
    expect(entry!.chapters.map((c) => c.title)).toEqual(["add an item", "see it added"]);
    const offsets = entry!.chapters.map((c) => c.atMs);
    expect(offsets[0]).toBeGreaterThanOrEqual(0);
    expect(offsets[1]).toBeGreaterThanOrEqual(offsets[0]!);
  }, 120_000);

  it("#210: a run that types secrets (environment or mailbox) keeps the video alone, through validateSuite", async () => {
    const run = await new ArtifactStore(BASE).openRun("secrets");
    await run.writeSuite({ files: [SHOP] });

    const report = await validateSuite(run.dir, { screencast: true, secretsInRun: true, reruns: 1, workers: 1 });
    expect(report.results.map((r) => r.status)).toEqual(["passed"]);
    const [entry] = report.screencasts!;
    expect(entry!.video).toMatch(/\.webm$/);
    expect(entry!.trace).toBeUndefined();
    expect(entry!.timing).toBe("estimated");
    const files = await readdir(run.dir, { recursive: true });
    expect(files.filter((f) => f.endsWith(".zip"))).toEqual([]);
  }, 120_000);
});
