import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { runSpecs } from "../../src/validate/runner.js";
import { validateSuite } from "../../src/validate/index.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const BASE = join(process.cwd(), "runs", ".itest-error-context");
/** Where Playwright puts its output when the config names no `outputDir`: beside the nearest package.json. */
const STRAY = join(process.cwd(), "test-results");

// Short on purpose: a short value is the one a loose mask lets through.
const TOKEN = "tkQ7x2";
const COOKIE = "ckW4p9";
const TOKEN_VAR = "CAIRN_ITEST_256_TOKEN";

/** The test's own request fails: Playwright's error then carries the call log, with both headers in it. */
const spec = (url: string): { path: string; content: string } => ({
  path: "me.spec.ts",
  content: `import { test, expect } from '@playwright/test';
test('me', async ({ page, request }) => {
  await page.setContent('<h1>Me</h1>');
  await page.waitForTimeout(300);
  const res = await request.get('${url}/api/me', { headers: { Authorization: 'Bearer ' + process.env.${TOKEN_VAR} } });
  await expect(res).toBeOK();
});`,
});

/** Every file under `dir` whose bytes hold one of `values`, as a path relative to `dir`. */
async function filesHolding(dir: string, values: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    if (values.some((v) => bytes.includes(Buffer.from(v)))) hits.push(path.slice(dir.length + 1));
  }
  return hits;
}

describe("#256 a failed test's request log stays off the disk", () => {
  let server: Server;
  let url = "";
  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("set-cookie", `sid=${COOKIE}; Path=/`);
      res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    process.env[TOKEN_VAR] = TOKEN;
  });
  afterAll(async () => {
    delete process.env[TOKEN_VAR];
    await new Promise((r) => server.close(r));
    await rm(BASE, { recursive: true, force: true });
  });

  it("Validate · runSpecs · the output folder is inside the run and holds neither Authorization nor set-cookie", async () => {
    const strayBefore = existsSync(STRAY);
    const run = await new ArtifactStore(BASE).openRun("plain");
    await run.writeSuite({ files: [spec(url)] });

    const results = await runSpecs(run.dir, { workers: 1 });
    expect(results.map((r) => r.status)).toEqual(["failed"]);

    // The failure context is written into the run, and it still says what the answer was.
    const context = join(run.dir, "test-results", "me-me", "error-context.md");
    expect(await readFile(context, "utf8")).toContain("← 401");
    expect(await filesHolding(run.dir, [TOKEN, COOKIE])).toEqual([]);
    if (!strayBefore) expect(existsSync(STRAY)).toBe(false);
  }, 120_000);

  it("Validate · validateSuite --screencast · the video stays, the request log does not", async () => {
    const run = await new ArtifactStore(BASE).openRun("screencast");
    await run.writeSuite({ files: [spec(url)] });

    // The token comes from the environment, so the run types a secret and records no trace (#210).
    const report = await validateSuite(run.dir, { screencast: true, secretsInRun: true, reruns: 1, workers: 1 });
    expect(report.results.map((r) => r.status)).toEqual(["failed"]);
    const files = await readdir(join(run.dir, "screencasts"), { recursive: true });
    expect(files.some((f) => f.endsWith(".webm"))).toBe(true);
    expect(files.some((f) => f.endsWith("error-context.md"))).toBe(true);
    expect(await filesHolding(run.dir, [TOKEN, COOKIE])).toEqual([]);
  }, 120_000);
});
