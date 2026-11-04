import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ingestOpenApi } from "../../src/api/openapi.js";
import { discoverSpec, SPEC_PATHS } from "../../src/api/discover.js";
import { BUDGET_EXIT_CODE, RequestGuard, parseBaseUrl } from "../../src/api/guard.js";

/**
 * #227: `cairn api --base-url <url>` without `--spec` looks for a spec the server already serves.
 * A real local HTTP server (ephemeral port) records every request the lookup makes.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

interface Hit {
  method: string;
  path: string;
  /** The request target as sent, query included. */
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
interface Served {
  url: string;
  hits: Hit[];
  close: () => Promise<void>;
}

/** A local server: `routes` answer by path, everything else is 404. A route that never answers hangs. */
async function serve(routes: Record<string, (res: ServerResponse) => void> = {}): Promise<Served> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      hits.push({ method: req.method ?? "", path, url: req.url ?? "/", headers: req.headers, body });
      const route = routes[path];
      if (route) return route(res);
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => {
      server.closeAllConnections(); // a hanging route keeps its socket open; close() alone would wait for it
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const send = (type: string, text: string) => (res: ServerResponse) => {
  res.writeHead(200, { "content-type": type });
  res.end(text);
};

/** Text that must never leave a local file: not in a request, not in the output. */
const MARKER = "LOCAL-MARKER-5b1e";
/** A one-operation spec whose query parameter's schema is `$ref: ref`; a resolved schema's `example` becomes the value sent. */
const specWithRef = (ref: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Ref", version: "1" },
    paths: {
      "/echo": {
        get: {
          parameters: [{ name: "q", in: "query", required: true, schema: { $ref: ref } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
/** A temp dir holding `ref.json`, a schema whose example is {@link MARKER}. */
async function markerFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "qa-api-discover-ref-"));
  const file = join(dir, "ref.json");
  await writeFile(file, JSON.stringify({ type: "string", example: MARKER }));
  return { dir, file };
}
/** Stand-in for the network: every `fetch` is answered here by URL (404 otherwise) and recorded; nothing leaves the process. */
function stubFetch(answers: Record<string, string>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const url = String(u);
      calls.push(url);
      const body = answers[url];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    }),
  );
  return calls;
}

let srv: Served | undefined;
let out: string;
let outChunks: string[];
let errChunks: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "qa-api-discover-"));
  outChunks = [];
  errChunks = [];
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => (outChunks.push(c.toString()), true));
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (errChunks.push(c.toString()), true));
  process.exitCode = 0;
});
afterEach(async () => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  await srv?.close();
  srv = undefined;
  await rm(out, { recursive: true, force: true });
});

const cli = async (...args: string[]): Promise<void> => {
  const { buildProgram } = await import("../../src/cli/index.js");
  await buildProgram().parseAsync(["node", "cairn", "api", "--out", out, "--rps", "1000", ...args]);
};
const openGuard = (): RequestGuard => new RequestGuard({ rps: 1000 });

describe("cairn api without --spec looks for a served spec (#227)", () => {
  it("finds the spec at /v3/api-docs, says where in one line, and builds the same model as --spec", async () => {
    const yaml = await readFile(join(fixtures, "petstore.yaml"), "utf8");
    srv = await serve({ "/v3/api-docs": send("application/yaml", yaml) });

    await cli("--base-url", srv.url);
    // Fetched once: the parser reads the text the lookup already has, it does not download the address again.
    expect(srv.hits.filter((h) => h.path === "/v3/api-docs")).toHaveLength(1);
    const text = outChunks.join("");
    const found = text.split("\n").filter((l) => l.includes("/v3/api-docs"));
    expect(found).toEqual([`✓ OpenAPI spec found at ${srv.url}/v3/api-docs`, `Source: ${srv.url}/v3/api-docs`]);
    expect(text).toContain("API spec: Pet Store v1.2.0 (OpenAPI 3.0.3)");
    // The Guardrails section counts the lookup's own requests (3 misses + the find), which are inside the run's budget.
    expect(text).toContain("spec lookup: 4 requests");
    expect(text).toContain(`request budget: ${srv.hits.length}/300 used`);
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as { guardrails: { specLookup?: unknown } };
    expect(report.guardrails.specLookup).toEqual({
      requests: 4,
      foundAt: `${srv.url}/v3/api-docs`,
      tried: ["/openapi.json", "/openapi.yaml", "/swagger.json"].map((p) => ({ url: `${srv!.url}${p}`, outcome: "404" })),
      skipped: [],
    });
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("spec lookup: 4 requests");

    const viaLookup = await discoverSpec({ baseUrl: srv.url, headers: {}, guard: openGuard() });
    expect(viaLookup.found).toBe(true);
    if (!viaLookup.found) return;
    expect(viaLookup.url).toBe(`${srv.url}/v3/api-docs`);
    expect(viaLookup.model).toEqual(await ingestOpenApi(join(fixtures, "petstore.yaml")));
  });

  it("nothing served anywhere: non-zero exit, and the message names all eight addresses and --spec", async () => {
    srv = await serve();
    await cli("--base-url", srv.url);
    const err = errChunks.join("");
    for (const p of SPEC_PATHS) expect(err).toContain(`${srv.url}${p} — 404`);
    expect(err).toContain("--spec <path|url>");
    expect(err).not.toMatch(/postman|har\b/i);
    expect(process.exitCode).toBe(1);
  });

  it("every lookup request is a GET with no body, in the documented order", async () => {
    srv = await serve();
    await cli("--base-url", srv.url);
    expect(SPEC_PATHS).toHaveLength(8);
    expect(srv.hits.map((h) => h.path)).toEqual([...SPEC_PATHS]);
    expect(srv.hits.map((h) => h.method)).toEqual(SPEC_PATHS.map(() => "GET"));
    expect(srv.hits.map((h) => h.body)).toEqual(SPEC_PATHS.map(() => ""));
    expect(srv.hits.every((h) => h.headers["content-length"] === undefined || h.headers["content-length"] === "0")).toBe(true);
  });

  it("a path that hangs times out and the next path is tried", { timeout: 10_000 }, async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({ "/openapi.json": () => undefined, "/openapi.yaml": send("application/json", json) });
    const started = Date.now();
    const res = await discoverSpec({ baseUrl: srv.url, headers: {}, guard: openGuard(), timeoutMs: 300 });
    expect(res.found && res.url).toBe(`${srv.url}/openapi.yaml`);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(srv.hits.map((h) => h.path)).toEqual(["/openapi.json", "/openapi.yaml"]);
  });

  it("a hanging path is reported as timed out when nothing else is found", { timeout: 10_000 }, async () => {
    srv = await serve({ "/openapi.json": () => undefined });
    const res = await discoverSpec({ baseUrl: srv.url, headers: {}, guard: openGuard(), timeoutMs: 300 });
    expect(res.found).toBe(false);
    if (res.found) return;
    expect(res.tried[0]).toEqual({ url: `${srv.url}/openapi.json`, outcome: "no answer within 0.3 s" });
    expect(res.tried).toHaveLength(8);
  });

  it("a body that stalls after the headers times out too, and the next path is tried", { timeout: 10_000 }, async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({
      "/openapi.json": (res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"openapi":"3.0.3",'); // headers and a first chunk, then nothing
      },
      "/openapi.yaml": send("application/json", json),
    });
    const started = Date.now();
    const res = await discoverSpec({ baseUrl: srv.url, headers: {}, guard: openGuard(), timeoutMs: 300 });
    expect(res.found && res.url).toBe(`${srv.url}/openapi.yaml`);
    expect(res.tried[0]).toEqual({ url: `${srv.url}/openapi.json`, outcome: "no answer within 0.3 s" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a redirect is not followed: a 302 to a real spec is reported and its target is never asked", async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({
      "/openapi.json": (res) => {
        res.writeHead(302, { location: "/real.json" });
        res.end();
      },
      "/real.json": send("application/json", json),
    });
    const res = await discoverSpec({ baseUrl: srv.url, headers: {}, guard: openGuard() });
    expect(res.found).toBe(false);
    expect(res.tried[0]).toEqual({ url: `${srv.url}/openapi.json`, outcome: "302 redirect, not followed" });
    expect(srv.hits.filter((h) => h.path === "/real.json")).toHaveLength(0);
  });

  it("a served spec whose $ref points at a local file is not used: the file is not read, nothing of it is sent or printed", async () => {
    const { dir, file } = await markerFile();
    try {
      srv = await serve({
        "/openapi.json": send("application/json", specWithRef(pathToFileURL(file).href)),
        "/echo": send("text/plain", "ok"),
      });
      await cli("--base-url", srv.url);
      expect(srv.hits.map((h) => h.url).join("\n")).not.toContain(MARKER);
      expect(outChunks.join("") + errChunks.join("")).not.toContain(MARKER);
      expect(errChunks.join("")).toMatch(/\/openapi\.json — 200, .*external \$ref is not followed for a spec found on the server/);
      expect(srv.hits.map((h) => h.path)).toEqual([...SPEC_PATHS]); // the next paths were tried, /echo never
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a served spec whose $ref points at another address is not used, and that address is not fetched", async () => {
    const calls = stubFetch({
      "https://api.test/openapi.json": specWithRef("./schemas.json#/Q"),
      "https://api.test/schemas.json": JSON.stringify({ Q: { type: "string" } }),
    });
    const res = await discoverSpec({ baseUrl: "https://api.test", headers: {}, guard: openGuard() });
    expect(res.found).toBe(false);
    expect(res.tried[0]?.outcome).toContain("external $ref is not followed for a spec found on the server");
    expect(calls).toEqual(SPEC_PATHS.map((p) => `https://api.test${p}`)); // never /schemas.json
  });

  it("--spec <url> does not read a local file its $ref points at; a spec file on disk still does (multi-file specs)", async () => {
    const { dir, file } = await markerFile();
    try {
      const spec = specWithRef(pathToFileURL(file).href);
      const calls = stubFetch({ "https://api.test/openapi.json": spec });
      await cli("--spec", "https://api.test/openapi.json");
      expect(outChunks.join("") + errChunks.join("")).not.toContain(MARKER);
      expect(errChunks.join("")).toContain('Could not read OpenAPI spec "https://api.test/openapi.json"');
      expect(process.exitCode).toBe(1);
      expect(calls).toEqual(["https://api.test/openapi.json"]);

      const onDisk = join(dir, "openapi.json");
      await writeFile(onDisk, spec);
      expect(JSON.stringify((await ingestOpenApi(onDisk)).endpoints[0]?.parameters)).toContain(MARKER);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a query string in --base-url stays on each lookup address, after the path", async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({ "/api/openapi.json": send("application/json", json) });
    const { baseUrl } = parseBaseUrl(`${srv.url}/api/?sig=abcd1234`);
    const res = await discoverSpec({ baseUrl, headers: {}, guard: openGuard() });
    expect(srv.hits.map((h) => h.url)).toEqual(["/api/openapi.json?sig=abcd1234"]);
    expect(res.found && res.url).toBe(`${srv.url}/api/openapi.json?sig=abcd1234`);
  });

  it("a 200 answer that is not a spec (an HTML page) is skipped and the next path is tried", async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({
      "/openapi.json": send("text/html", "<!doctype html><html><body><h1>Welcome</h1></body></html>"),
      "/swagger.json": send("application/json", json),
    });
    const res = await discoverSpec({ baseUrl: srv.url, headers: {}, guard: openGuard() });
    expect(res.found && res.url).toBe(`${srv.url}/swagger.json`);
    expect(res.found && res.model.title).toBe("Tiny API");
    expect(srv.hits.map((h) => h.path)).toEqual(["/openapi.json", "/openapi.yaml", "/swagger.json"]);
  });

  it("the lookup carries the run's headers: --header and api-scope knowledge credentials", async () => {
    const kdir = await mkdtemp(join(tmpdir(), "qa-api-discover-know-"));
    try {
      await mkdir(join(kdir, "api"), { recursive: true });
      await writeFile(join(kdir, "api", "auth.md"), "---\nscope: all\nheader.X-Shared: from-knowledge\n---\ncreds");
      const json = await readFile(join(fixtures, "tiny.json"), "utf8");
      srv = await serve({
        "/openapi.json": (res) => {
          const ok = srv!.hits.at(-1)!.headers.authorization === "Bearer TOKEN-1234";
          if (ok) return send("application/json", json)(res);
          res.writeHead(401);
          res.end();
        },
      });
      await cli(
        "--base-url", srv.url, "--knowledge-dir", kdir,
        "--header", "Authorization: Bearer TOKEN-1234", "--header", "X-HTTP-Method-Override: DELETE",
      );
      const lookup = srv.hits[0]!;
      expect(lookup.path).toBe("/openapi.json");
      expect(lookup.headers.authorization).toBe("Bearer TOKEN-1234");
      expect(lookup.headers["x-shared"]).toBe("from-knowledge");
      expect(lookup.headers["x-http-method-override"]).toBeUndefined(); // the GET must stay a GET
      expect(outChunks.join("")).toContain(`✓ OpenAPI spec found at ${srv.url}/openapi.json`);
      expect([outChunks.join(""), errChunks.join("")].join("\n")).not.toContain("TOKEN-1234");
    } finally {
      await rm(kdir, { recursive: true, force: true });
    }
  });

  it("the lookup obeys the run's guardrails: --max-requests counts its tries, --allowed-methods without GET sends nothing", async () => {
    srv = await serve();
    await cli("--base-url", srv.url, "--max-requests", "3");
    expect(srv.hits).toHaveLength(3);
    expect(errChunks.join("")).toContain("request budget ran out (--max-requests 3)");
    expect(process.exitCode).toBe(BUDGET_EXIT_CODE); // the runner's code for a spent budget, not 1

    errChunks.length = 0;
    process.exitCode = 0;
    await cli("--base-url", srv.url, "--allowed-methods", "HEAD");
    expect(srv.hits).toHaveLength(3); // nothing new
    expect(errChunks.join("")).toContain("--allowed-methods does not include GET");
    expect(process.exitCode).not.toBe(0);
  });

  it("--allowed-paths limits the lookup: a path it does not allow is skipped, not requested", async () => {
    srv = await serve();
    await cli("--base-url", srv.url, "--allowed-paths", "/pets/*");
    expect(srv.hits).toHaveLength(0);
    const err = errChunks.join("");
    expect(err).toContain("Skipped (not requested):");
    for (const p of SPEC_PATHS) expect(err).toContain(`${srv.url}${p} — not in --allowed-paths`);
    expect(err).not.toContain("Tried (GET):");
    expect(process.exitCode).toBe(1);
  });

  it("neither --spec nor --base-url: refused, and the message says either flag will do", async () => {
    await expect(cli()).rejects.toThrow(/--spec <path\|url>.*or --base-url <url>/);
  });
});

describe("cairn api --spec <url> on a local or private address (#234)", () => {
  it("reads a spec served on 127.0.0.1, and the model is the one the same file gives", async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({ "/openapi.json": send("application/json", json) });
    const { readSpecFromUrl } = await import("../../src/api/discover.js");
    const got = await readSpecFromUrl(`${srv.url}/openapi.json`, {});
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(await ingestOpenApi(`${srv.url}/openapi.json`, got.text)).toEqual(await ingestOpenApi(join(fixtures, "tiny.json")));
    await cli("--spec", `${srv.url}/openapi.json`);
    expect(outChunks.join("")).toContain("API spec:");
    expect(errChunks.join("")).not.toContain("$ref");
    expect(process.exitCode).toBe(0);
    expect(srv.hits.every((h) => h.method === "GET" && h.body === "")).toBe(true);
  });

  it("sends the run's headers (--header) and never a method-override one", async () => {
    const json = await readFile(join(fixtures, "tiny.json"), "utf8");
    srv = await serve({ "/openapi.json": send("application/json", json) });
    await cli("--spec", `${srv.url}/openapi.json`, "--header", "X-Token: t0k3n-abc", "--header", "X-HTTP-Method-Override: DELETE");
    expect(srv.hits[0]?.headers["x-token"]).toBe("t0k3n-abc");
    expect(srv.hits[0]?.headers["x-http-method-override"]).toBeUndefined();
  });

  it("a 401 says the server answered 401 and how to give credentials, not a $ref error", async () => {
    srv = await serve({ "/openapi.json": (res) => (res.writeHead(401), res.end("no")) });
    await cli("--spec", `${srv.url}/openapi.json`);
    const err = errChunks.join("");
    expect(err).toContain(`Could not read OpenAPI spec "${srv.url}/openapi.json": the server answered 401`);
    expect(err).toContain("--header");
    expect(err).not.toContain("$ref");
    expect(process.exitCode).toBe(1);
  });

  it("a redirect is not followed, and the message names where it pointed", async () => {
    srv = await serve({
      "/openapi.json": (res) => (res.writeHead(302, { location: "/real.json" }), res.end()),
      "/real.json": send("application/json", "{}"),
    });
    await cli("--spec", `${srv.url}/openapi.json`);
    const err = errChunks.join("");
    expect(err).toContain("answered 302");
    expect(err).toContain("/real.json");
    expect(err).toContain("not followed");
    expect(srv.hits.map((h) => h.path)).toEqual(["/openapi.json"]);
  });

  it("a $ref in a spec read from a local address that points at a private address is still not fetched", async () => {
    srv = await serve({ "/openapi.json": send("application/json", specWithRef("http://127.0.0.1:1/x.json#/a")) });
    await cli("--spec", `${srv.url}/openapi.json`);
    expect(process.exitCode).toBe(1);
    expect(errChunks.join("")).toContain("Could not read OpenAPI spec");
    expect(srv.hits.map((h) => h.path)).toEqual(["/openapi.json"]);
  });

  it("the read counts against --max-requests, and --allowed-methods without GET sends nothing", async () => {
    srv = await serve({ "/openapi.json": send("application/json", "{}") });
    await cli("--spec", `${srv.url}/openapi.json`, "--allowed-methods", "HEAD");
    expect(srv.hits).toHaveLength(0);
    expect(errChunks.join("")).toContain("--allowed-methods does not include GET");
    expect(process.exitCode).toBe(1);
  });
});
