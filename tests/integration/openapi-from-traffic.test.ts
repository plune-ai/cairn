import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/index.js";
import { runDesign, runExploration } from "../../src/agent/index.js";
import { ingestOpenApi } from "../../src/api/openapi.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import type { BrowserGateway } from "../../src/browser/index.js";

/**
 * #229: while `explore` / `design` drive a SPA in real Chromium, the app's own API requests — those made while the
 * page loads and those its clicks start — are folded into openapi.derived.json in the run dir. The LLM-driven graph is
 * replaced by a script that clicks through the SPA's screens with the run's real gateway; everything else is the run.
 */
vi.mock("../../src/eval/judge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/eval/judge.js")>()),
  judgeTestCases: async () => [],
}));
vi.mock("../../src/eval/pilot.js", async (orig) => ({
  ...(await orig<typeof import("../../src/eval/pilot.js")>()),
  pilotReview: async () => {
    throw new Error("no LLM in this test");
  },
}));
vi.mock("../../src/agent/graph.js", () => ({
  runExploreGraph: async (deps: { gateway: BrowserGateway }, { url }: { url: string }) => {
    const g = deps.gateway;
    const click = async (name: string): Promise<void> => {
      const el = parseAriaSnapshot((await g.observe({})).ariaSnapshot).find((e) => e.role === "button" && e.name === name);
      if (!el) throw new Error(`no button "${name}" on the page`);
      await g.act({ kind: "click", ref: el.ref });
    };
    const first = await g.observe({ url });
    await new Promise((r) => setTimeout(r, 300)); // the requests the page makes while it loads
    for (const name of ["Projects", "Open Alpha", "Projects", "Open Beta", "Projects", "New project", "Settings"]) await click(name);
    return {
      study: { url, screenshotB64: "", ariaYaml: first.ariaSnapshot, capturedBy: "lib", elements: [] },
      analysis: { pageSemantics: "A projects app", primaryRefs: [], viewSwitchers: [] },
      verified: [],
      transitions: [],
      testCases: [
        {
          id: "tc-1",
          title: "lists the projects",
          technique: "exploratory",
          kind: "static",
          type: "Positive",
          execution: "manual",
          preconditions: [],
          steps: ["open the page", "press Projects"],
          expected: "the projects are listed",
          priority: "high",
          elementRefs: [],
        },
      ],
      stoppedEarly: false,
      attempts: 0,
      clicks: [],
    };
  },
}));

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "site");

/** Every made-up credential the SPA and its API carry. */
const TOKENS = [
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzcGEifQ.FAKEspaSIGNATURE0229",
  "FAKEspaSIGNATURE0229",
  "FAKE-spa-xapikey-31337",
  "FAKE-spa-Pa55word!",
  "FAKE-spa-qtoken-8c7d",
  "FAKE-spa-tp-uid-4242",
  "FAKE-spa-resp-token-6b5a",
  "FAKE-spa-session-1f2e3d",
];

const project = (id: number) => ({ id, name: id === 123 ? "Alpha" : id === 456 ? "Beta" : `Project ${id}`, public: id !== 123, owner: id === 123 ? { id: 9, email: "owner@example.test" } : null });

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe("an OpenAPI draft from the traffic recorded while exploring the UI (#229, real Chromium)", () => {
  const thirdPartyHits: string[] = [];
  const app = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0]!;
      const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.method === "GET" && (path === "/app.html" || path === "/settings")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await readFile(join(site, "projects-spa.html")));
      } else if (path === "/static/app.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body { font-family: sans-serif; }");
      } else if (path === "/static/logo.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      } else if (req.method === "POST" && path === "/api/session") {
        send(200, { token: "FAKE-spa-resp-token-6b5a", user: { id: 9 } }, { "set-cookie": "session=FAKE-spa-session-1f2e3d; Path=/; HttpOnly" });
      } else if (req.method === "GET" && path === "/api/me") {
        send(200, { id: 9, email: "qa@example.test" });
      } else if (req.method === "GET" && path === "/api/projects") {
        send(200, [project(123), project(456)]);
      } else if (req.method === "GET" && /^\/api\/projects\/\d+$/.test(path)) {
        send(200, project(Number(path.split("/").pop())));
      } else if (req.method === "POST" && path === "/api/projects") {
        send(201, project(789));
      } else if (req.method === "GET" && path === "/api/watch") {
        // A watch stream: the answer starts and never ends.
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
      } else if (req.method === "GET" && path === "/api/vault/opensesame") {
        send(200, { open: true });
      } else if (req.method === "GET" && path === "/api/settings") {
        send(200, { theme: "dark", notifications: true });
      } else {
        send(404, { error: "not found" });
      }
    })();
  });
  const thirdParty = createServer((req, res) => {
    thirdPartyHits.push(req.url ?? "");
    res.writeHead(204, { "access-control-allow-origin": "*" });
    res.end();
  });
  let appUrl = "";
  let thirdUrl = "";
  let base = "";

  beforeAll(async () => {
    appUrl = await listen(app);
    thirdUrl = await listen(thirdParty);
    base = await mkdtemp(join(tmpdir(), "cairn-229-"));
  });
  afterAll(async () => {
    app.closeAllConnections();
    thirdParty.closeAllConnections();
    await new Promise((r) => app.close(r));
    await new Promise((r) => thirdParty.close(r));
    await rm(base, { recursive: true, force: true });
  });

  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let out: string[];
  beforeEach(() => {
    out = [];
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(c.toString()), true));
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
  });

  const start = (): string => `${appUrl}/app.html?tp=${encodeURIComponent(thirdUrl)}`;
  const config = () => loadConfig({ LLM_PROFILE: "openrouter", OPENROUTER_API_KEY: "test-key-not-used", BROWSER_BACKEND: "lib" });

  it("after explore, openapi.derived.json is in the run dir: ingestOpenApi reads it, ids are folded, no third party, no token", { timeout: 90_000 }, async () => {
    const events: string[] = [];
    const result = await runExploration({ url: start(), config: config(), runsBaseDir: base, knowledgeDir: join(base, "none"), fresh: true, onProgress: (e) => events.push(e) });
    const file = join(result.runDir, "openapi.derived.json");
    const saved = await readFile(file, "utf8");

    const model = await ingestOpenApi(file);
    expect(model.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      "GET /api/me",
      "GET /api/projects",
      "GET /api/projects/{id}",
      "GET /api/settings",
      "POST /api/projects",
      "POST /api/session",
    ]);
    const one = model.endpoints.find((e) => e.path === "/api/projects/{id}")!;
    expect(one.parameters).toContainEqual({ name: "id", in: "path", required: true, schema: { type: "integer" } });
    expect(one.responses[0]!.schema).toMatchObject({ type: "object", properties: { owner: { type: "object", nullable: true } } });
    expect(model.endpoints.find((e) => e.path === "/api/projects" && e.method === "POST")!.responses.map((r) => r.status)).toEqual(["201"]);

    // The third party was called, and is not in the spec.
    expect(thirdPartyHits.some((u) => u.startsWith("/collect"))).toBe(true);
    expect(saved).not.toContain(thirdUrl);
    expect(saved).not.toContain("/collect");
    for (const t of TOKENS) expect(saved, t).not.toContain(t);
    expect(saved).not.toMatch(/"(?:authorization|cookie|set-cookie)"/i);
    expect(events.join("\n")).toMatch(/api — \d+ API request\(s\) → 6 operation\(s\) → openapi\.derived\.json/);
  });

  it("after design too; and `cairn api --spec openapi.derived.json` runs on the same app", { timeout: 90_000 }, async () => {
    const result = await runDesign({ url: start(), config: config(), runsBaseDir: base, knowledgeDir: join(base, "none"), fresh: true });
    const file = join(result.runDir, "openapi.derived.json");
    expect(JSON.parse(await readFile(file, "utf8"))["x-cairn-derived"]).toBe(true);

    const apiOut = join(base, "api-run");
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", file, "--base-url", appUrl, "--out", apiOut, "--rps", "1000"]);
    const text = out.join("");
    expect(text).toContain("API spec: 127.0.0.1");
    // GETs are sent and pass; the two POSTs are listed but not sent (no --allow-mutations).
    expect(text).toMatch(/4\/4 case\(s\) passed · 2 not sent/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("an origin allowed with --api-origin goes into the spec as well", { timeout: 90_000 }, async () => {
    const result = await runDesign({ url: start(), config: config(), runsBaseDir: base, knowledgeDir: join(base, "none"), fresh: true, apiOrigins: thirdUrl });
    const model = await ingestOpenApi(join(result.runDir, "openapi.derived.json"));
    expect(model.endpoints.map((e) => `${e.method} ${e.path}`)).toContain("POST /collect");
    const saved = await readFile(join(result.runDir, "openapi.derived.json"), "utf8");
    expect(saved).not.toContain("FAKE-spa-tp-uid-4242");
  });
  it("a JSON answer that never ends does not hold the run: its body is cut off after a few seconds and the request is kept", { timeout: 90_000 }, async () => {
    const events: string[] = [];
    const t0 = Date.now();
    const result = await runExploration({ url: `${start()}&call=/api/watch`, config: config(), runsBaseDir: base, knowledgeDir: join(base, "none"), fresh: true, onProgress: (e) => events.push(e) });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(events.join("\n")).toMatch(/1 response body cut off/);
    const model = await ingestOpenApi(join(result.runDir, "openapi.derived.json"));
    const watch = model.endpoints.find((e) => e.method === "GET" && e.path === "/api/watch");
    expect(watch?.responses.map((r) => r.status)).toEqual(["200"]);
    await readFile(join(result.runDir, "report.json"), "utf8");
  });

  it("a value known only from the run's own secrets (knowledge) is scrubbed from the file when the traffic carries it", { timeout: 90_000 }, async () => {
    const knowledge = join(base, "knowledge-vault");
    await mkdir(knowledge, { recursive: true });
    await writeFile(join(knowledge, "vault.md"), "The vault opens with these credentials.\n\nLogin: qa@example.test\nPassword: opensesame\n");
    const result = await runExploration({ url: `${start()}&call=/api/vault/opensesame`, config: config(), runsBaseDir: base, knowledgeDir: knowledge, fresh: true });
    const saved = await readFile(join(result.runDir, "openapi.derived.json"), "utf8");
    expect(saved).toContain("/api/vault/");
    expect(saved).not.toContain("opensesame");
  });
});
