import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { runSpecs } from "../../src/validate/runner.js";
import { isMissingBrowserError } from "../../src/browser/preflight.js";
import { parseApiFlows, renderFlowFixture, FLOW_FIXTURE_FILE } from "../../src/api/flows.js";

// Run directories must live INSIDE the project: spec files resolve @playwright/test via node_modules.
const ITEST_BASE = join(process.cwd(), "runs", ".itest-api-flows");

/** A tiny app: a project API, a page per project, and a sign-in that sets a cookie. */
interface App {
  url: string;
  projects: Map<string, string>;
  created: number;
  deleted: number;
  /** Every request the server received, as `METHOD /path?query`. */
  log: string[];
  close: () => Promise<void>;
}

async function startApp(): Promise<App> {
  let next = 1;
  const app = { projects: new Map<string, string>(), created: 0, deleted: 0, log: [] } as unknown as App;
  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      let s = "";
      req.on("data", (c: Buffer) => (s += c.toString()));
      req.on("end", () => ok(s));
    });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://app");
      const body = await readBody(req);
      app.log.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && url.pathname === "/api/projects/odd") {
        // An answer whose id cannot name anything: "" or "..", as the query asks.
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: url.searchParams.get("id") ?? "" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/broken") {
        res.writeHead(500).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/projects") {
        const { name } = JSON.parse(body) as { name: string };
        const id = `p${next++}`;
        app.projects.set(id, name);
        app.created++;
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id, name }));
        return;
      }
      const del = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && del) {
        const existed = app.projects.delete(decodeURIComponent(del[1]!));
        if (existed) app.deleted++;
        res.writeHead(existed ? 204 : 404).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const form = new URLSearchParams(body);
        if (form.get("user") === "ada" && form.get("password") === "s3cret-pass") {
          res.writeHead(204, { "set-cookie": "sid=ok; Path=/; HttpOnly" }).end();
        } else res.writeHead(401).end();
        return;
      }
      const page = /^\/projects\/([^/]+)$/.exec(url.pathname);
      const html = (h1: string): void =>
        void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>t</title><h1>${h1}</h1>`);
      if (page) return html(app.projects.get(decodeURIComponent(page[1]!)) ?? "Not found");
      if (url.pathname === "/me") return html(/(^|;\s*)sid=ok/.test(req.headers.cookie ?? "") ? "Signed in" : "Signed out");
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  app.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.close = () => new Promise((ok) => server.close(() => ok()));
  return app;
}

const flowFile = parseApiFlows(
  JSON.stringify({
    version: 1,
    flows: [
      {
        name: "project",
        description: "a project to open in the UI",
        steps: [
          {
            name: "create project",
            method: "POST",
            path: "/api/projects",
            body: { name: "Project {{uid}}" },
            expect: 201,
            capture: { projectId: "/id", projectName: "/name" },
          },
        ],
        returns: ["projectId", "projectName"],
        cleanup: [{ name: "delete project", method: "DELETE", path: "/api/projects/{{projectId}}", expect: [204, 404] }],
      },
      {
        name: "signedIn",
        kind: "signin",
        steps: [{ method: "POST", path: "/api/login", form: { user: "{{env.APP_USER}}", password: "{{env.APP_PASSWORD}}" } }],
      },
    ],
  }),
);

/** Flows whose answers leave nothing to clean up by: an empty id, a `..` id, a second step that fails. */
const edgeFile = parseApiFlows(
  JSON.stringify({
    version: 1,
    flows: [
      {
        name: "blank",
        steps: [{ method: "POST", path: "/api/projects/odd", query: { id: "" }, expect: 201, capture: { id: "/id" } }],
        returns: ["id"],
        cleanup: [{ method: "DELETE", path: "/api/projects/{{id}}", expect: [204, 404] }],
      },
      {
        name: "dots",
        steps: [{ method: "POST", path: "/api/projects/odd", query: { id: ".." }, expect: 201, capture: { id: "/id" } }],
        returns: ["id"],
        cleanup: [{ method: "DELETE", path: "/api/projects/{{id}}", expect: [204, 404] }],
      },
      {
        name: "pair",
        steps: [
          { method: "POST", path: "/api/projects", body: { name: "Pair {{uid}}" }, expect: 201, capture: { projectId: "/id" } },
          { method: "POST", path: "/api/broken", expect: 201, capture: { otherId: "/id" } },
        ],
        returns: ["projectId", "otherId"],
        cleanup: [
          { method: "DELETE", path: "/api/others/{{otherId}}", expect: [204, 404] },
          { method: "DELETE", path: "/api/projects/{{projectId}}", expect: [204, 404] },
        ],
      },
    ],
  }),
);

const spec = (body: string): string => `import { test, expect } from './api-flows.fixture';\n${body}\n`;

describe("API flow fixture in a UI test (#230, integration, real playwright runner)", () => {
  let app: App;
  beforeAll(async () => {
    app = await startApp();
    process.env.APP_USER = "ada";
    process.env.APP_PASSWORD = "s3cret-pass";
  });
  afterAll(async () => {
    await app.close();
    delete process.env.APP_USER;
    delete process.env.APP_PASSWORD;
    await rm(ITEST_BASE, { recursive: true, force: true });
  });

  it("a UI test uses the created object, and after the test — passed or failed — the object is gone", { timeout: 120000 }, async (ctx) => {
    const run = await new ArtifactStore(ITEST_BASE).openRun("allowed");
    await run.writeSuite({
      files: [
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(flowFile, { baseUrl: app.url, allowMutationsFor: app.url }) },
        {
          path: "opens.spec.ts",
          content: spec(`test('opens the project', async ({ page, project }) => {
  await page.goto('${app.url}/projects/' + project.projectId);
  await expect(page.getByRole('heading', { name: project.projectName })).toBeVisible();
});`),
        },
        {
          path: "fails.spec.ts",
          content: spec(`test('fails on purpose', async ({ page, project }) => {
  await page.goto('${app.url}/projects/' + project.projectId);
  await expect(page.getByRole('heading', { name: 'Some other name' })).toBeVisible({ timeout: 1000 });
});`),
        },
        {
          path: "signin.spec.ts",
          content: spec(`test('signed in through the API', async ({ page }) => {
  await page.goto('${app.url}/me');
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
});`),
        },
      ],
    });

    let results: Awaited<ReturnType<typeof runSpecs>>;
    try {
      results = await runSpecs(run.dir, { workers: 1 });
    } catch (e) {
      if (isMissingBrowserError(e)) return ctx.skip();
      throw e;
    }
    const status = Object.fromEntries(results.map((r) => [r.title, r.status]));
    expect(status).toEqual({ "opens the project": "passed", "fails on purpose": "failed", "signed in through the API": "passed" });
    expect(app.created).toBe(2); // one project per test that asked for it
    expect(app.deleted).toBe(2); // the failed test's project too
    expect([...app.projects.keys()]).toEqual([]);
  });

  it("a flow that changes data does not run against an address no flag allowed — the test is skipped, nothing is sent", { timeout: 120000 }, async (ctx) => {
    const before = app.created;
    const run = await new ArtifactStore(ITEST_BASE).openRun("locked");
    await run.writeSuite({
      files: [
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(flowFile, { baseUrl: app.url }) },
        {
          path: "opens.spec.ts",
          content: spec(`test('opens the project', async ({ page, project }) => {
  await page.goto('${app.url}/projects/' + project.projectId);
});`),
        },
      ],
    });
    let results: Awaited<ReturnType<typeof runSpecs>>;
    try {
      results = await runSpecs(run.dir, { workers: 1 });
    } catch (e) {
      if (isMissingBrowserError(e)) return ctx.skip();
      throw e;
    }
    expect(results).toEqual([{ title: "opens the project", status: "skipped" }]);
    expect(app.created).toBe(before);
  });

  it("a captured id that cannot name anything ('' or '..') is not used: no DELETE is sent for it", { timeout: 120000 }, async (ctx) => {
    app.log.length = 0;
    const run = await new ArtifactStore(ITEST_BASE).openRun("odd-ids");
    await run.writeSuite({
      files: [
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(edgeFile, { baseUrl: app.url, allowMutationsFor: app.url }) },
        { path: "blank.spec.ts", content: spec(`test('blank id', async ({ blank }) => { expect(blank).toBeTruthy(); });`) },
        { path: "dots.spec.ts", content: spec(`test('dots id', async ({ dots }) => { expect(dots.id).toBe('..'); });`) },
      ],
    });
    let results: Awaited<ReturnType<typeof runSpecs>>;
    try {
      results = await runSpecs(run.dir, { workers: 1 });
    } catch (e) {
      if (isMissingBrowserError(e)) return ctx.skip();
      throw e;
    }
    expect(app.log.filter((l) => l.startsWith("DELETE"))).toEqual([]);
    const byTitle = Object.fromEntries(results.map((r) => [r.title, r]));
    expect(byTitle["blank id"]?.status).toBe("failed");
    expect(byTitle["blank id"]?.error).toMatch(/the answer has no value at \/id for id/);
    // ".." is a value, but not one segment of a path: the test gets it, the cleanup does not send it
    expect(byTitle["dots id"]?.status).toBe("passed");
  });

  it("#251: a template in a cleanup step's name does not leave the step out", { timeout: 120000 }, async () => {
    app.log.length = 0;
    const named = parseApiFlows(
      JSON.stringify({
        version: 1,
        flows: [
          {
            name: "named",
            steps: [{ method: "POST", path: "/api/projects", body: { name: "Named {{uid}}" }, expect: 201, capture: { id: "/id" } }],
            returns: ["id"],
            cleanup: [{ name: "delete {{nope}}", method: "DELETE", path: "/api/projects/{{id}}", expect: [204, 404] }],
          },
        ],
      }),
    );
    const run = await new ArtifactStore(ITEST_BASE).openRun("named-cleanup");
    await run.writeSuite({
      files: [
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(named, { baseUrl: app.url, allowMutationsFor: app.url }) },
        // It takes no `page`: the runner opens no browser.
        { path: "named.spec.ts", content: spec(`test('named', async ({ named }) => { expect(named.id).toBeTruthy(); });`) },
      ],
    });
    const results = await runSpecs(run.dir, { workers: 1 });
    expect(results.map((r) => r.status)).toEqual(["passed"]);
    expect(app.log.filter((l) => l.startsWith("DELETE"))).toHaveLength(1);
  });

  it("a cleanup step that needs a value a failed step never captured is left out; the rest of the cleanup runs", { timeout: 120000 }, async (ctx) => {
    app.log.length = 0;
    const run = await new ArtifactStore(ITEST_BASE).openRun("pair");
    await run.writeSuite({
      files: [
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(edgeFile, { baseUrl: app.url, allowMutationsFor: app.url }) },
        { path: "pair.spec.ts", content: spec(`test('pair', async ({ pair }) => { expect(pair).toBeTruthy(); });`) },
      ],
    });
    let results: Awaited<ReturnType<typeof runSpecs>>;
    try {
      results = await runSpecs(run.dir, { workers: 1 });
    } catch (e) {
      if (isMissingBrowserError(e)) return ctx.skip();
      throw e;
    }
    expect(results.map((r) => r.status)).toEqual(["failed"]);
    expect(results[0]!.error).toMatch(/step "POST \/api\/broken" answered 500/);
    expect(results[0]!.error).not.toMatch(/cleanup failed/);
    expect(app.log.filter((l) => l.startsWith("DELETE"))).toEqual([expect.stringMatching(/^DELETE \/api\/projects\/p\d+$/)]);
    expect([...app.projects.keys()]).toEqual([]);
  });

  it("#250: a value that cannot stand in a path, and a request with no answer, reach the report without any value", { timeout: 120000 }, async () => {
    const secret = "S3CRET-q7";
    process.env.FLOW_SEG = `sec/${secret}`;
    process.env.FLOW_TOKEN = secret;
    const secrets = parseApiFlows(
      JSON.stringify({
        version: 1,
        flows: [
          { name: "badPath", steps: [{ method: "GET", path: "/api/{{env.FLOW_SEG}}" }] },
          { name: "noAnswer", steps: [{ name: "read", method: "GET", path: "/api/projects", headers: { Authorization: "Bearer {{env.FLOW_TOKEN}}" } }] },
        ],
      }),
    );
    const run = await new ArtifactStore(ITEST_BASE).openRun("no-values");
    await run.writeSuite({
      files: [
        // Port 1 refuses: nothing is listening, and the fixture's request gets no answer.
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(secrets, { baseUrl: "http://127.0.0.1:1" }) },
        { path: "bad.spec.ts", content: spec(`test('bad path', async ({ badPath }) => { expect(badPath).toBeTruthy(); });`) },
        { path: "none.spec.ts", content: spec(`test('no answer', async ({ noAnswer }) => { expect(noAnswer).toBeTruthy(); });`) },
      ],
    });
    try {
      // No test here takes `page`: the runner opens no browser.
      const results = await runSpecs(run.dir, { workers: 1 });
      const byTitle = Object.fromEntries(results.map((r) => [r.title, r]));
      expect(byTitle["bad path"]?.error).toMatch(/\{\{env\.FLOW_SEG\}\} is a value, which cannot stand in the path \/api\/\{\{env\.FLOW_SEG\}\}/);
      expect(byTitle["no answer"]?.error).toMatch(/API flow "noAnswer" step "read" got no answer: ECONNREFUSED/);
      expect(JSON.stringify(results)).not.toContain(secret);
    } finally {
      delete process.env.FLOW_SEG;
      delete process.env.FLOW_TOKEN;
    }
  });

  it("#250: a test's own failed request and expect(response).toBeOK() reach the report without their call log", { timeout: 120000 }, async () => {
    const secret = "S3CRET-q7";
    const headers = `{ headers: { Authorization: 'Bearer ${secret}' } }`;
    const caught = (title: string, then: string): string =>
      `test('${title}', async ({ request }) => { try { await request.get('http://127.0.0.1:1/api/${secret}', ${headers}); } catch (e) { ${then} } });`;
    const run = await new ArtifactStore(ITEST_BASE).openRun("no-request-log");
    await run.writeSuite({
      files: [
        { path: "failed.spec.ts", content: `import { test } from '@playwright/test';\ntest('failed request', async ({ request }) => { await request.get('http://127.0.0.1:1/api/${secret}', ${headers}); });\n` },
        {
          path: "ok.spec.ts",
          content: `import { test, expect } from '@playwright/test';\ntest('not ok', async ({ request }) => { await expect(await request.post('${app.url}/api/broken?k=${secret}', ${headers})).toBeOK(); });\n`,
        },
        {
          path: "carried.spec.ts",
          content: `import { test, expect } from '@playwright/test';\n${[
            caught("a diff", "expect((e as Error).message).toBe('x');"),
            caught("a substring", "expect((e as Error).message).toContain('nope');"),
            caught("indented", "throw new Error('Failed:\\n' + (e as Error).message.replace(/^/gm, '    '));"),
            caught("no heading", "throw new Error('Failed:\\n' + (e as Error).message.split('Call log:')[1]);"),
          ].join("\n")}\n`,
        },
      ],
    });
    // The POST's answer is what this test reads, so the write guard (#285) lets it through.
    const results = await runSpecs(run.dir, { workers: 1, allowWrites: true });
    const byTitle = Object.fromEntries(results.map((r) => [r.title, r]));
    expect(byTitle["failed request"]?.error).toMatch(/apiRequestContext\.get: connect ECONNREFUSED/);
    expect(byTitle["not ok"]?.error).toMatch(/toBeOK/);
    expect(byTitle["not ok"]?.error).toContain("← 500 Internal Server Error");
    expect(results.filter((r) => r.status === "failed")).toHaveLength(6);
    expect(JSON.stringify(results)).not.toContain(secret);
  });

  it("a sign-in flow that would send a second request that changes data sends nothing", { timeout: 120000 }, async (ctx) => {
    app.log.length = 0;
    // Built past parseApiFlows (which refuses it) to prove the fixture itself refuses it too.
    const signin = flowFile.flows.find((f) => f.kind === "signin")!;
    const bad = {
      ...flowFile,
      flows: [{ ...signin, steps: [...signin.steps, { method: "DELETE" as const, path: "/api/projects/everything" }] }],
    };
    const run = await new ArtifactStore(ITEST_BASE).openRun("signin-delete");
    await run.writeSuite({
      files: [
        { path: FLOW_FIXTURE_FILE, content: renderFlowFixture(bad, { baseUrl: app.url }) },
        { path: "me.spec.ts", content: spec(`test('me', async ({ page }) => { await page.goto('${app.url}/me'); });`) },
      ],
    });
    let results: Awaited<ReturnType<typeof runSpecs>>;
    try {
      results = await runSpecs(run.dir, { workers: 1 });
    } catch (e) {
      if (isMissingBrowserError(e)) return ctx.skip();
      throw e;
    }
    expect(results.map((r) => r.status)).toEqual(["failed"]);
    expect(app.log.filter((l) => l.startsWith("DELETE"))).toEqual([]);
    expect(app.log.filter((l) => l.startsWith("POST"))).toEqual([]);
  });
});
