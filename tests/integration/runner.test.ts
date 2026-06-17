import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { runSpecs } from "../../src/validate/runner.js";
import { isMissingBrowserError } from "../../src/browser/preflight.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const ITEST_BASE = join(process.cwd(), "runs", ".itest-runner");

describe("runSpecs (integration, real playwright runner)", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it("passed for a valid spec, failed/timedOut for a broken one", { timeout: 120000 }, async (ctx) => {
    await rm(ITEST_BASE, { recursive: true, force: true });
    try {
      const run = await new ArtifactStore(ITEST_BASE).openRun("rtest");
      await run.writeSuite({
        files: [
          {
            path: "good.spec.ts",
            content: `import { test, expect } from '@playwright/test';
test('good', async ({ page }) => {
  await page.goto('${server.url}/login.html');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
});`,
          },
          {
            path: "bad.spec.ts",
            content: `import { test, expect } from '@playwright/test';
test('bad', async ({ page }) => {
  await page.goto('${server.url}/login.html');
  await expect(page.getByRole('button', { name: 'Nonexistent' })).toBeVisible({ timeout: 2000 });
});`,
          },
        ],
      });

      let results: Awaited<ReturnType<typeof runSpecs>>;
      try {
        results = await runSpecs(run.dir);
      } catch (e) {
        // This integration test needs the @playwright/test runner's browser (chrome-headless-shell).
        // If it isn't installed, skip rather than fail — `npx playwright install chromium` provisions it.
        // (Verifies, in passing, that runSpecs now surfaces the missing browser instead of a fake 0%.)
        if (isMissingBrowserError(e)) {
          ctx.skip();
          return;
        }
        throw e;
      }
      const good = results.find((r) => r.title === "good");
      const bad = results.find((r) => r.title === "bad");
      expect(good?.status).toBe("passed");
      expect(bad?.status === "failed" || bad?.status === "timedOut").toBe(true);
    } finally {
      await rm(ITEST_BASE, { recursive: true, force: true });
    }
  });
});
