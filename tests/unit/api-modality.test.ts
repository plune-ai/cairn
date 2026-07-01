import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * C1-04 / API-1 (#22): the `cairn api` command — registration, the parsed-model summary, the
 * file-path-vs-URL source, and clean (non-crashing) failure on a bad spec. The real ingest is
 * exercised in api-openapi.test.ts; here we mock it where we only care about the wiring.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

let outChunks: string[];
let errChunks: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => (outChunks.push(c.toString()), true));
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (errChunks.push(c.toString()), true));
  process.exitCode = 0;
});
afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = 0;
  vi.resetModules();
  vi.doUnmock("../../src/api/openapi.js");
});

describe("cairn api command (real ingest)", () => {
  it("is registered with a required --spec option", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    const api = buildProgram().commands.find((c) => c.name() === "api");
    expect(api).toBeDefined();
    const spec = api?.options.find((o) => o.long === "--spec");
    expect(spec?.required).toBe(true);
  });

  it("ingests a YAML spec and prints the parsed-model summary", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml")]);
    const out = outChunks.join("");
    expect(out).toContain("API spec: Pet Store v1.2.0 (OpenAPI 3.0.3)");
    expect(out).toContain("4 endpoint(s) across 2 tag(s)");
    expect(out).toContain("1 security scheme(s)");
    expect(out).toContain("GET    /pets");
    expect(out).toContain("DELETE /pets/{id}");
    // API-6 (#136): coverage is meaningful even without a run — spec-vs-generated-cases.
    expect(out).toContain("Coverage (3/4 endpoint(s)");
    expect(out).toMatch(/⚠ partial\s+GET\s+\/pets\/\{id\} \(getPet\) — tested: 200 · missing: 404/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fails cleanly (stderr + exit 1, no throw) on a malformed spec", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", join(fixtures, "malformed.yaml")]);
    expect(errChunks.join("")).toMatch(/✗ Could not read OpenAPI spec/);
    expect(process.exitCode).toBe(1);
  });
});

describe("cairn api --base-url run path (API-3, mocked network)", () => {
  let unstub: (() => void) | undefined;
  afterEach(() => {
    unstub?.();
    unstub = undefined;
    vi.unstubAllGlobals();
  });

  /** Stub global fetch with a per-method canned response; capture the headers each call received. */
  function stubFetch(): { headers: Record<string, string>[] } {
    const headers: Record<string, string>[] = [];
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push({ ...(init.headers as Record<string, string>) });
      const status = init.method === "POST" ? 201 : init.method === "DELETE" ? 204 : 200;
      const body = init.method === "GET" ? (_url.includes("{") || _url.endsWith("/pets") ? "[]" : "{}") : "";
      return { status, headers: { get: () => null }, text: async () => body } as unknown as Response;
    });
    vi.stubGlobal("fetch", fn);
    return { headers };
  }

  it("runs every case, merges config-over-knowledge auth, writes redacted evidence, exits 0", async () => {
    const kdir = await mkdtemp(join(tmpdir(), "qa-api-know-"));
    const out = await mkdtemp(join(tmpdir(), "qa-api-out-"));
    try {
      await mkdir(join(kdir, "api"), { recursive: true });
      // api-scope creds: a shared header + one that config will override.
      await writeFile(join(kdir, "api", "auth.md"), "---\nscope: all\nheader.X-Shared: from-knowledge\nheader.X-Key: KNOWLEDGE\n---\ncreds");

      const { headers } = stubFetch();
      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync([
        "node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"),
        "--base-url", "https://api.test", "--knowledge-dir", kdir, "--out", out,
        "--header", "Authorization: Bearer SECRET", "--header", "X-Key: CONFIG",
      ]);

      expect(headers).toHaveLength(4); // one request per generated case
      const sent = headers[0]!;
      expect(sent["X-Shared"]).toBe("from-knowledge"); // knowledge header applied
      expect(sent["X-Key"]).toBe("CONFIG"); // config overrides knowledge on the same header
      expect(sent["Authorization"]).toBe("Bearer SECRET"); // config-only header applied

      const out0 = outChunks.join("");
      expect(out0).toContain("4/4 case(s) passed");
      // C1-04 / API-4 (#134): the shared run-summary footer (same renderer as web runs).
      expect(out0).toMatch(/Operations: 4\/4 passed · 4 endpoint\(s\) covered/);
      expect(out0).toContain("Artifacts:");
      expect(process.exitCode ?? 0).toBe(0);

      const evidence = JSON.parse(await readFile(join(out, "api-evidence.json"), "utf8")) as { request: { headers: Record<string, string> } }[];
      expect(evidence).toHaveLength(4);
      expect(evidence[0]!.request.headers["Authorization"]).toBe("***"); // secret redacted on disk

      // API-4: report.json/report.md — the TUI's past-run browser reads these for any mode.
      const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
        mode: string;
        url: string;
        api: { passed: number; total: number; endpointCount: number };
      };
      expect(report.mode).toBe("api");
      expect(report.url).toBe("https://api.test");
      expect(report.api).toEqual({ passed: 4, total: 4, endpointCount: 4 });

      const reportMd = await readFile(join(out, "report.md"), "utf8");
      expect(reportMd).toContain("4/4 passed");
      expect(reportMd).toContain("4 endpoint(s) covered");
      expect(reportMd).toContain("api-evidence.json");

      // API-5 (#135): methodology-tagged cases in report.json + ATC artifacts on the same boundary
      // (`testcases/<id>.md`) web runs use.
      const reportCases = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
        cases: { name: string; technique: string; rationale: string }[];
      };
      expect(reportCases.cases).toHaveLength(4);
      for (const rc of reportCases.cases) {
        expect(rc.technique).toBe("equivalence-partitioning");
        expect(rc.rationale.length).toBeGreaterThan(0);
      }

      const { readdir } = await import("node:fs/promises");
      const tcDir = join(out, "testcases");
      const tcFileNames = await readdir(tcDir);
      expect(tcFileNames).toHaveLength(4);
      expect(tcFileNames.every((f) => /^ATC-PET-STORE-API-\d{3}\.md$/.test(f))).toBe(true);
      const listPetsMd = await readFile(join(tcDir, "ATC-PET-STORE-API-001.md"), "utf8");
      expect(listPetsMd).toContain('title: "listPets"');
      expect(listPetsMd).toContain("technique: equivalence-partitioning");
      expect(listPetsMd).toContain("status: ✅ Passed");
      expect(out0).toContain("Cases (ATC .md):");

      // API-6 (#136): spec-vs-tested coverage — getPet declares 200+404 but the happy-path case only
      // targets 200, so it's "partial" even though this run is 4/4 GREEN — coverage ≠ pass rate.
      const reportCoverage = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
        coverage: { endpointCount: number; coveredCount: number; partialCount: number; uncoveredCount: number };
      };
      expect(reportCoverage.coverage).toMatchObject({ endpointCount: 4, coveredCount: 3, partialCount: 1, uncoveredCount: 0 });
      expect(reportMd).toContain("Coverage (3/4 endpoint(s)");
      expect(reportMd).toContain("⚠ partial | GET | /pets/{id}");
      expect(out0).toContain("Coverage (3/4 endpoint(s)");
      expect(out0).toContain("partially covered");
    } finally {
      await rm(kdir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a case fails its assertion", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-out2-"));
    try {
      // 404 is non-transient → fails fast (no retry/backoff), keeping the test quick.
      vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }) as unknown as Response));
      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync([
        "node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"),
        "--base-url", "https://api.test", "--out", out,
      ]);
      expect(outChunks.join("")).toMatch(/0\/4 case\(s\) passed/);
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("cairn api source resolution (mocked ingest)", () => {
  it("passes an http(s) URL through verbatim, but resolves a local path to absolute", async () => {
    const ingestOpenApi = vi.fn().mockResolvedValue({
      openapiVersion: "3.0.0",
      endpoints: [],
      tags: [],
      securitySchemes: [],
    });
    vi.doMock("../../src/api/openapi.js", () => ({ ingestOpenApi }));
    vi.resetModules();
    const { buildProgram } = await import("../../src/cli/index.js");

    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", "https://example.com/openapi.yaml"]);
    expect(ingestOpenApi).toHaveBeenLastCalledWith("https://example.com/openapi.yaml");

    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", "./spec.json"]);
    expect(ingestOpenApi).toHaveBeenLastCalledWith(resolve("./spec.json"));
  });
});
