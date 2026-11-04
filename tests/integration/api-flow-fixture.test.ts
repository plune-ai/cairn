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
  close: () => Promise<void>;
}

async function startApp(): Promise<App> {
  let next = 1;
  const app = { projects: new Map<string, string>(), created: 0, deleted: 0 } as App;
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
});
