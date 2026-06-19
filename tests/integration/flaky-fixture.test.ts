import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { validateSuite } from "../../src/validate/index.js";
import { isMissingBrowserError } from "../../src/browser/preflight.js";

const ITEST_BASE = join(process.cwd(), "runs", ".itest-flaky");

const spec = (name: string, body: string): string =>
  `import { test, expect } from '@playwright/test';\ntest('${name}', async ({ page }) => {\n${body}\n});`;

describe("flaky-hardening discriminator (integration, real playwright)", () => {
  let server: FixtureServer;
  beforeAll(async () => { server = await startFixtureServer(); });
  afterAll(async () => { await server.close(); });

  it("hardened spec stays green; fragile spec does not (#57)", { timeout: 180000 }, async (ctx) => {
    await rm(ITEST_BASE, { recursive: true, force: true });
    try {
      const hardened = await new ArtifactStore(join(ITEST_BASE, "hardened")).openRun("h");
      await hardened.writeSuite({ files: [{ path: "h.spec.ts", content: spec("hardened", `
  await page.goto('${server.url}/flaky.html');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();`) }] });

      const fragile = await new ArtifactStore(join(ITEST_BASE, "fragile")).openRun("f");
      await fragile.writeSuite({ files: [{ path: "f.spec.ts", content: spec("fragile", `
  await page.goto('${server.url}/flaky.html');
  await page.getByRole('button', { name: 'Load' }).click();
  await page.waitForTimeout(50);
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 50 });`) }] });

      let hardenedReport: Awaited<ReturnType<typeof validateSuite>>;
      let fragileReport: Awaited<ReturnType<typeof validateSuite>>;
      try {
        hardenedReport = await validateSuite(hardened.dir, { reruns: 5 });
        fragileReport = await validateSuite(fragile.dir, { reruns: 5 });
      } catch (e) {
        if (isMissingBrowserError(e)) { ctx.skip(); return; }
        throw e;
      }
      expect(hardenedReport.greenRatio).toBe(1);        // web-first waiting → rock-solid
      expect(fragileReport.greenRatio).toBeLessThan(1); // 100ms sleep vs 400ms mount → never green
    } finally {
      await rm(ITEST_BASE, { recursive: true, force: true });
    }
  });
});
