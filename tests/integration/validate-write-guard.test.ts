import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { validateSuite } from "../../src/validate/index.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const BASE = join(process.cwd(), "runs", ".itest-write-guard");
/** A path segment shaped like a credential: the guard's messages must mask it. */
const TOKEN = "9f86d081884c7d659a2feaa0c55ad015";

/** None of the writing tests asserts anything: without the guard they pass, and their writes reach the server. */
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
test('seeds through the page', async ({ page }) => {
  await page.request.post('${url}/api/items/${TOKEN}', { data: { name: 'x' } });
});
test('reads through the API', async ({ request }) => {
  expect((await request.get('${url}/')).ok()).toBe(true);
});`,
});

const serve = async (writes: string[], html: (path: string) => string): Promise<{ server: Server; url: string }> => {
  const server = createServer((req, res) => {
    if (req.method !== "GET") writes.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "text/html");
    res.setHeader("access-control-allow-origin", "*");
    res.end(req.method === "GET" ? html(req.url ?? "/") : "<p>Thanks</p>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` };
};

describe("#285 validation runs under the write guard", () => {
  let app: Server;
  let api: Server;
  let url = "";
  let apiUrl = "";
  const writes: string[] = [];
  const apiWrites: string[] = [];
  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    ({ server: api, url: apiUrl } = await serve(apiWrites, () => "<p>api</p>"));
    ({ server: app, url } = await serve(writes, (path) =>
      path === "/spa"
        ? `<button onclick="fetch('${apiUrl}/items', { method: 'POST', body: 'x' }).catch(() => {}); this.textContent = 'Sent'">Save</button>`
        : path === "/beacon"
          ? `<button onclick="navigator.sendBeacon('/collect', 'x'); this.textContent = 'Counted'">Count</button>`
          : `<form method="post" action="/submit"><input name="q" value="1"><button>Send</button></form>`,
    ));
  });
  beforeEach(() => {
    writes.length = 0;
    apiWrites.length = 0;
  });
  afterAll(async () => {
    await new Promise((r) => app.close(r));
    await new Promise((r) => api.close(r));
    await rm(BASE, { recursive: true, force: true });
  });

  it("Validate · validateSuite · a form post, a request write and a page.request write never reach the target; the tests fail and the log names them", async () => {
    const run = await new ArtifactStore(BASE).openRun("guarded");
    await run.writeSuite({ files: [spec(url)] });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], log: (l) => log.push(l) });

    expect(writes).toEqual([]);
    expect(report.results.map((r) => [r.test, r.status])).toEqual([
      ["submits the form", "failed"],
      ["seeds through the API", "failed"],
      ["seeds through the page", "failed"],
      ["reads through the API", "passed"],
    ]);
    expect(report.results.filter((r) => r.status === "failed").every((r) => r.error?.includes("write guard"))).toBe(true);
    expect(log.some((l) => l.includes(`POST ${url}/submit`))).toBe(true);
    expect(log.some((l) => l.includes(`POST ${url}/api/items `))).toBe(true);
    expect(log.some((l) => l.includes(`POST ${url}/api/items/‹v›`))).toBe(true);
    // The test's error goes into report.json and the repair prompt: its URL is masked as the log's is.
    expect(report.results.find((r) => r.test === "seeds through the page")?.error).toContain(`POST ${url}/api/items/‹v›`);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(log.join("\n")).not.toContain(TOKEN);
  }, 120_000);

  it("Validate · validateSuite · an SPA's write to another origin is aborted and logged once for that origin, and fails no test", async () => {
    const run = await new ArtifactStore(BASE).openRun("spa");
    await run.writeSuite({
      files: [
        {
          path: "spa.spec.ts",
          content: `import { test, expect } from '@playwright/test';
test('saves', async ({ page }) => {
  await page.goto('${url}/spa');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Sent' }).click();
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: 'Sent' })).toBeVisible();
});`,
        },
      ],
    });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], log: (l) => log.push(l) });

    expect(apiWrites).toEqual([]);
    expect(report.results.map((r) => r.status)).toEqual(["passed"]);
    expect(log.filter((l) => l.includes(apiUrl))).toEqual([`validate — write guard: blocked POST to another origin, ${apiUrl} (2×; aborted, fails no test)`]);
  }, 120_000);

  it("Validate · validateSuite · a same-origin sendBeacon is aborted and logged, and fails no test", async () => {
    const run = await new ArtifactStore(BASE).openRun("beacon");
    await run.writeSuite({
      files: [
        {
          path: "beacon.spec.ts",
          content: `import { test, expect } from '@playwright/test';
test('counts', async ({ page }) => {
  await page.goto('${url}/beacon');
  await page.getByRole('button', { name: 'Count' }).click();
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: 'Counted' })).toBeVisible();
});`,
        },
      ],
    });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], log: (l) => log.push(l) });

    expect(writes).toEqual([]);
    expect(report.results.map((r) => r.status)).toEqual(["passed"]);
    expect(log.some((l) => l.includes(`blocked POST ${url}/collect`))).toBe(true);
  }, 120_000);

  it("Validate · validateSuite --allow-mutations · the writes reach the servers and the tests pass", async () => {
    const run = await new ArtifactStore(BASE).openRun("allowed");
    await run.writeSuite({ files: [spec(url)] });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], allowWrites: true, log: (l) => log.push(l) });

    expect(writes).toEqual(["POST /submit", "POST /api/items", `POST /api/items/${TOKEN}`]);
    expect(report.results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(log).toEqual([]);
  }, 120_000);

  it("Validate · validateSuite · a spec that imports playwright/test is guarded too, and its own chromium.launch() is refused", async () => {
    const run = await new ArtifactStore(BASE).openRun("playwright-test");
    await run.writeSuite({
      files: [
        {
          path: "alias.spec.ts",
          content: `import { test, chromium } from 'playwright/test';
test('submits the form', async ({ page }) => {
  await page.goto('${url}/');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(500);
});
test('own browser', async () => {
  const browser = await chromium.launch();
  await browser.close();
});`,
        },
      ],
    });

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url] });

    expect(writes).toEqual([]);
    expect(report.results.map((r) => [r.test, r.status])).toEqual([
      ["submits the form", "failed"],
      ["own browser", "failed"],
    ]);
    expect(report.results[1]?.error).toContain("refuses chromium.launch()");
  }, 120_000);

  it("Validate · validateSuite · request.newContext() (export and playwright fixture) is guarded, a context stringifies, and playwright / playwright-core browser types are refused", async () => {
    const run = await new ArtifactStore(BASE).openRun("contexts");
    const launch = (from: string): string => `import { test } from '@playwright/test';
import { chromium } from '${from}';
test('launch from ${from}', async () => {
  await chromium.launch();
});`;
    await run.writeSuite({
      files: [
        {
          path: "contexts.spec.ts",
          content: `import { test, request } from '@playwright/test';
test('own API context', async () => {
  const api = await request.newContext();
  await api.post('${url}/api/own');
});
test('fixture API context', async ({ playwright }) => {
  const api = await playwright.request.newContext();
  await api.post('${url}/api/fixture');
});
test('stringifies', async ({ context, page }) => {
  String(context.request);
  String(page.request);
});`,
        },
        { path: "pw.spec.ts", content: launch("playwright") },
        { path: "core.spec.ts", content: launch("playwright-core") },
      ],
    });
    const log: string[] = [];

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url], log: (l) => log.push(l) });

    expect(writes).toEqual([]);
    const status = Object.fromEntries(report.results.map((r) => [r.test, r.status]));
    expect(status).toEqual({
      "own API context": "failed",
      "fixture API context": "failed",
      stringifies: "passed",
      "launch from playwright": "failed",
      "launch from playwright-core": "failed",
    });
    expect(log.some((l) => l.includes(`POST ${url}/api/own`))).toBe(true);
    expect(log.some((l) => l.includes(`POST ${url}/api/fixture`))).toBe(true);
    for (const t of ["launch from playwright", "launch from playwright-core"]) {
      expect(report.results.find((r) => r.test === t)?.error).toContain("refuses chromium.launch()");
    }
  }, 120_000);

  it("Validate · validateSuite · a test that ran where the guard never loaded fails the validation run (fail closed)", async () => {
    const run = await new ArtifactStore(BASE).openRun("unguarded");
    // A relative path is not a specifier the guard maps.
    const real = relative(join(run.dir, "tests"), join(process.cwd(), "node_modules", "@playwright", "test", "index.mjs")).replace(/\\/g, "/");
    await run.writeSuite({
      files: [{ path: "direct.spec.ts", content: `import { test } from '${real}';\ntest('reads', async ({ page }) => { await page.goto('${url}/'); });\n` }],
    });

    await expect(validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url] })).rejects.toThrow(/1 test\(s\) ran without the write guard/);
  }, 120_000);

  it("Validate · validateSuite · a read through the guarded `request` keeps Playwright's own call name in its error", async () => {
    const run = await new ArtifactStore(BASE).openRun("read-error");
    await run.writeSuite({
      files: [{ path: "read.spec.ts", content: `import { test } from '@playwright/test';\ntest('read', async ({ request }) => { await request.get('http://127.0.0.1:1/x'); });\n` }],
    });

    const report = await validateSuite(run.dir, { reruns: 1, workers: 1, guardOrigins: [url] });

    expect(report.results[0]?.error).toMatch(/apiRequestContext\.get: connect ECONNREFUSED/);
  }, 120_000);
});
