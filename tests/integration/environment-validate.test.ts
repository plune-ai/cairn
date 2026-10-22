import { describe, it, expect, afterAll } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { applyEnvironment, writeTempSession } from "../../src/environment/apply.js";
import { parseEnvironment } from "../../src/environment/config.js";
import { runSpecs } from "../../src/validate/runner.js";
import { startEnvApp, type EnvApp } from "../fixtures/env-app.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const BASE = join(process.cwd(), "runs", ".itest-environment");

describe("validation run with an environment (generated config + real runner)", () => {
  let app: EnvApp | undefined;
  afterAll(async () => {
    await app?.close();
    await rm(BASE, { recursive: true, force: true });
  });

  it("passes Basic Auth from env var NAMES and reuses the login session; no secret lands on disk", async () => {
    const secrets = { VB_U: "stage", VB_P: "Basic-Run-Pass-9", VA_U: "qa@example.com", VA_P: "App-Run-Pass-9" };
    app = await startEnvApp({ basic: { user: secrets.VB_U, pass: secrets.VB_P }, login: { user: secrets.VA_U, pass: secrets.VA_P } });
    Object.assign(process.env, secrets);
    try {
      const env = parseEnvironment({
        baseUrl: app.url,
        basicAuth: { usernameVar: "VB_U", passwordVar: "VB_P" },
        user: { usernameVar: "VA_U", passwordVar: "VA_P" },
        startPath: "/start",
      });
      const applied = await applyEnvironment(env);
      const sessionPath = writeTempSession(applied.storageState!);

      await rm(BASE, { recursive: true, force: true });
      const run = await new ArtifactStore(BASE).openRun("env");
      await run.writeSuite({
        files: [
          {
            path: "start.spec.ts",
            content: `import { test, expect } from '@playwright/test';
test('start page is reachable with the environment', async ({ page }) => {
  await page.goto('${applied.startUrl}');
  await expect(page.getByRole('heading', { name: 'Start page' })).toBeVisible();
});`,
          },
        ],
      });

      const results = await runSpecs(run.dir, {
        storageStatePath: sessionPath,
        httpCredentialsEnv: applied.httpCredentialsEnv,
        workers: 1,
      });
      expect(results.map((r) => r.status)).toEqual(["passed"]);

      const config = await readFile(join(run.dir, "playwright.config.cjs"), "utf8");
      for (const v of Object.values(secrets)) expect(config).not.toContain(v);
      expect(config).toContain('process.env["VB_P"]');
    } finally {
      for (const k of ["VB_U", "VB_P", "VA_U", "VA_P"]) delete process.env[k];
    }
  }, 120_000);
});
