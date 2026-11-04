import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ingestOpenApi } from "../../src/api/openapi.js";
import { discoverSpec, SPEC_PATHS } from "../../src/api/discover.js";
import { RequestGuard } from "../../src/api/guard.js";

/**
 * #227: `cairn api --base-url <url>` without `--spec` looks for a spec the server already serves.
 * A real local HTTP server (ephemeral port) records every request the lookup makes.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

interface Hit {
  method: string;
  path: string;
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
      hits.push({ method: req.method ?? "", path, headers: req.headers, body });
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
    const found = outChunks.join("").split("\n").filter((l) => l.includes("/v3/api-docs"));
    expect(found).toEqual([`✓ OpenAPI spec found at ${srv.url}/v3/api-docs`, `Source: ${srv.url}/v3/api-docs`]);
    expect(outChunks.join("")).toContain("API spec: Pet Store v1.2.0 (OpenAPI 3.0.3)");

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
    expect(process.exitCode).not.toBe(0);

    errChunks.length = 0;
    process.exitCode = 0;
    await cli("--base-url", srv.url, "--allowed-methods", "HEAD");
    expect(srv.hits).toHaveLength(3); // nothing new
    expect(errChunks.join("")).toContain("--allowed-methods does not include GET");
    expect(process.exitCode).not.toBe(0);
  });

  it("neither --spec nor --base-url: refused, and the message says either flag will do", async () => {
    await expect(cli()).rejects.toThrow(/--spec <path\|url>.*or --base-url <url>/);
  });
});
