import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { validateSuite } from "../../src/validate/index.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const BASE = join(process.cwd(), "runs", ".itest-write-guard");

/** Neither test asserts anything: without the guard both pass, and their writes reach the server. */
const spec = (url: string): { path: string; content: string } => ({
  path: "writes.spec.ts",
  content: `import { test, expect } from '@playwright/test';
test('submits the form', async ({ page }) => {
  await page.goto('${url}/');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(500);
  expect(page.url()).toContain('/');
});
test('seeds through the API', async ({ request }) => {
  await request.post('${url}/api/items', { data: { name: 'x' } });
});
test('reads through the API', async ({ request }) => {
  expect((await request.get('${url}/')).ok()).toBe(true);
});`,
});

describe("#285 validation runs under the write guard", () => {
  let server: Server;
  let url = "";
  const writes: string[] = [];
  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    server = createServer((req, res) => {
      if (req.method !== "GET") writes.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "text/html");
      res.end(req.method === "GET" ? `<form method="post" action="/submit"><input name="q" value="1"><button>Send</button></form>` : "<p>Thanks</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  beforeEach(() => {
    writes.length = 0;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(BASE, { recursive: true, force: true });
  });

  it("Validate · validateSuite · a form post and an API write never reach the target; the tests fail and the log names them", async () => {
    const run = await new ArtifactStore(BASE).openRun("guarded");
    await run.writeSuite({ files: [spec(url)] });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], log: (l) => log.push(l) });

    expect(writes).toEqual([]);
    expect(report.results.map((r) => [r.test, r.status])).toEqual([
      ["submits the form", "failed"],
      ["seeds through the API", "failed"],
      ["reads through the API", "passed"],
    ]);
    expect(report.results.filter((r) => r.status === "failed").every((r) => r.error?.includes("write guard"))).toBe(true);
    expect(log.some((l) => l.includes(`POST ${url}/submit`))).toBe(true);
    expect(log.some((l) => l.includes(`POST ${url}/api/items`))).toBe(true);
  }, 120_000);

  it("Validate · validateSuite · another origin's write is not the target's and goes through", async () => {
    const run = await new ArtifactStore(BASE).openRun("other-origin");
    await run.writeSuite({ files: [spec(url)] });

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: ["https://app.example.com"] });

    expect(writes).toEqual(["POST /submit", "POST /api/items"]);
    expect(report.results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
  }, 120_000);

  it("Validate · validateSuite --allow-mutations · the writes reach the server and the tests pass", async () => {
    const run = await new ArtifactStore(BASE).openRun("allowed");
    await run.writeSuite({ files: [spec(url)] });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], allowWrites: true, log: (l) => log.push(l) });

    expect(writes).toEqual(["POST /submit", "POST /api/items"]);
    expect(report.results.map((r) => r.status)).toEqual(["passed", "passed", "passed"]);
    expect(log).toEqual([]);
  }, 120_000);

  it("Validate · validateSuite · a read through the guarded `request` keeps Playwright's own call name in its error", async () => {
    const run = await new ArtifactStore(BASE).openRun("read-error");
    await run.writeSuite({
      files: [{ path: "read.spec.ts", content: `import { test } from '@playwright/test';
test('read', async ({ request }) => { await request.get('http://127.0.0.1:1/x'); });
` }],
    });

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url] });

    expect(report.results[0]?.error).toMatch(/apiRequestContext\.get: connect ECONNREFUSED/);
  }, 120_000);
});
