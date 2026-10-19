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
        "--base-url", "https://api.test", "--allow-mutations", "--rps", "1000", "--knowledge-dir", kdir, "--out", out,
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
        "--base-url", "https://api.test", "--allow-mutations", "--rps", "1000", "--out", out,
      ]);
      expect(outChunks.join("")).toMatch(/0\/4 case\(s\) passed/);
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("(API-8, #145) --negative adds one contract-violation case per operation with something to violate", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-out3-"));
    try {
      // A server that actually enforces its contract: rejects the malformed createPet body (id sent
      // as a number, not the declared string) with 400 — the case the plain happy-path stub can't catch.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          if (init.method === "POST") {
            const body = JSON.parse(init.body as string) as { id: unknown };
            const status = typeof body.id === "string" ? 201 : 400;
            return { status, headers: { get: () => null }, text: async () => "" } as unknown as Response;
          }
          const status = init.method === "DELETE" ? 204 : 200;
          const bodyText = init.method === "GET" ? (_url.includes("{") || _url.endsWith("/pets") ? "[]" : "{}") : "";
          return { status, headers: { get: () => null }, text: async () => bodyText } as unknown as Response;
        }),
      );
      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync([
        "node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"),
        "--base-url", "https://api.test", "--allow-mutations", "--rps", "1000", "--out", out, "--negative",
      ]);

      const out0 = outChunks.join("");
      expect(out0).toContain("5 case(s) generated (1 negative-schema)");
      expect(out0).toContain("5/5 case(s) passed"); // the malformed body IS correctly rejected (400)
      expect(process.exitCode ?? 0).toBe(0);

      const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
        cases: { name: string; type: string }[];
      };
      expect(report.cases).toHaveLength(5);
      const neg = report.cases.find((c) => c.type === "Negative");
      expect(neg?.name).toBe("createPet (negative)");

      const { readdir } = await import("node:fs/promises");
      const tcFileNames = await readdir(join(out, "testcases"));
      expect(tcFileNames).toHaveLength(5);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("(API-9, #146) --scenarios chains create → read → update → delete, threading the captured id", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-out4-"));
    try {
      // Echoes whatever id is in the URL back in the body — the scenario's downstream URLs only ever
      // carry "abc123" (createItem's response id) if the runner actually threaded it through; the
      // base per-operation cases (independent, unthreaded synthetic ids) get a valid response either way.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/items" && init.method === "POST") {
            const body = JSON.parse(init.body as string) as { name: string };
            return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: "abc123", name: body.name }) } as unknown as Response;
          }
          const item = path.match(/^\/items\/([^/]+)$/);
          if (item && (init.method === "GET" || init.method === "PUT")) {
            return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: item[1], name: "string" }) } as unknown as Response;
          }
          if (item && init.method === "DELETE") {
            return { status: 204, headers: { get: () => null }, text: async () => "" } as unknown as Response;
          }
          if (path === "/widgets" && init.method === "POST") {
            return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: "w1", label: "string" }) } as unknown as Response;
          }
          const widget = path.match(/^\/widgets\/([^/]+)$/);
          if (widget && init.method === "GET") {
            return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: widget[1], label: "string" }) } as unknown as Response;
          }
          if (widget && init.method === "DELETE") {
            return { status: 204, headers: { get: () => null }, text: async () => "" } as unknown as Response;
          }
          return { status: 201, headers: { get: () => null }, text: async () => "" } as unknown as Response; // recordEvent — no response schema
        }),
      );

      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync([
        "node", "cairn", "api", "--spec", join(fixtures, "crud-store.yaml"),
        "--base-url", "https://api.test", "--allow-mutations", "--rps", "1000", "--out", out, "--scenarios",
      ]);

      const out0 = outChunks.join("");
      expect(out0).toContain("Scenarios (2 chain(s) generated)");
      expect(out0).toContain("2/2 scenario(s) passed");
      expect(process.exitCode ?? 0).toBe(0);

      const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
        scenarios: { name: string; passed: boolean; steps: { name: string; url: string; passed: boolean }[] }[];
      };
      const items = report.scenarios.find((s) => s.name === "items lifecycle")!;
      expect(items.passed).toBe(true);
      expect(items.steps.map((s) => s.name)).toEqual(["createItem", "getItem", "updateItem", "deleteItem"]);
      // Every downstream step's URL carries the id captured from createItem's response — proof the
      // declared `links` (crud-store.yaml) actually drove the threading, not a coincidence.
      for (const s of items.steps.slice(1)) expect(s.url).toBe("https://api.test/items/abc123");

      const reportMd = await readFile(join(out, "report.md"), "utf8");
      expect(reportMd).toContain("## Scenarios (2/2 passed)");
      expect(reportMd).toContain("### ✓ items lifecycle");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("(API-9, #146) a failing create step aborts the scenario — later steps recorded as skipped, non-zero exit", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-out5-"));
    try {
      // 200 instead of the declared 201 — a non-transient status mismatch, so it fails fast (no retry).
      vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => "{}" }) as unknown as Response));
      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync([
        "node", "cairn", "api", "--spec", join(fixtures, "crud-store.yaml"),
        "--base-url", "https://api.test", "--allow-mutations", "--rps", "1000", "--out", out, "--scenarios",
      ]);

      expect(process.exitCode).toBe(1);
      const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
        scenarios: { name: string; passed: boolean; steps: { error?: string }[] }[];
      };
      const items = report.scenarios.find((s) => s.name === "items lifecycle")!;
      expect(items.passed).toBe(false);
      expect(items.steps[1]!.error).toMatch(/^skipped/);
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

describe("cairn api --min-coverage (#197)", () => {
  const run = async (...extra: string[]) => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"), ...extra]);
  };

  it("petstore is 3 / 4 covered (75%): --min-coverage 80 exits 3 and lists the gaps", async () => {
    await run("--min-coverage", "80");
    const out = outChunks.join("");
    expect(out).toContain("Coverage gate: FAILED — 3 / 4 operation(s) covered = 75% (min 80%)");
    expect(out).toMatch(/✗ partial\s+GET\s+\/pets\/\{id\} \(getPet\)/);
    expect(process.exitCode).toBe(3);
  });

  it("--min-coverage 75 passes", async () => {
    await run("--min-coverage", "75");
    expect(outChunks.join("")).toContain("Coverage gate: passed — 3 / 4");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("--count-partial adds the partial operation (4 / 4 = 100%)", async () => {
    await run("--min-coverage", "100", "--count-partial");
    expect(outChunks.join("")).toContain("4 / 4 operation(s) covered + partial = 100%");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("rejects a value outside 0..100 or not a number before any work", async () => {
    for (const bad of ["101", "abc"]) {
      await expect(run("--min-coverage", bad)).rejects.toThrow(/--min-coverage must be a number from 0 to 100/);
    }
    expect(outChunks.join("")).not.toContain("API spec:");
  });

  it("warns that --count-partial does nothing without --min-coverage", async () => {
    await run("--count-partial");
    expect(errChunks.join("")).toContain("--count-partial has no effect without --min-coverage");
  });

  it("a bad value through the real top-level handler prints one clean line and exits 1", async () => {
    const { runCli } = await import("../../src/cli/index.js");
    const argv = process.argv;
    process.argv = ["node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"), "--min-coverage", "abc"];
    try {
      await runCli();
    } finally {
      process.argv = argv;
    }
    expect(errChunks.join("")).toContain('--min-coverage must be a number from 0 to 100 (got "abc").');
    expect(process.exitCode).toBe(1);
  });

  describe("with --base-url", () => {
    afterEach(() => vi.unstubAllGlobals());
    const stub = (ok: boolean) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const status = !ok ? 404 : init.method === "POST" ? 201 : init.method === "DELETE" ? 204 : 200;
          const body = !ok || init.method !== "GET" ? "" : String(url).endsWith("/pets") ? "[]" : "{}";
          return { status, headers: { get: () => null }, text: async () => body } as unknown as Response;
        }),
      );
    const runBase = async (out: string, ...extra: string[]) => {
      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync([
        "node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"),
        "--base-url", "https://api.test", "--out", out, ...extra,
      ]);
    };

    it("failing tests plus a failing gate: exit 1, the gate line is still printed and written to both reports", async () => {
      const out = await mkdtemp(join(tmpdir(), "qa-api-gate-"));
      try {
        stub(false);
        await runBase(out, "--allow-mutations", "--rps", "1000", "--min-coverage", "80");
        expect(process.exitCode).toBe(1);
        expect(outChunks.join("")).toContain("Coverage gate: FAILED — 3 / 4");
        const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as {
          coverageGate: { passed: boolean; counted: number; total: number; percent: number; threshold: number; missing: unknown[] };
        };
        expect(report.coverageGate).toMatchObject({ passed: false, counted: 3, total: 4, percent: 75, threshold: 80 });
        expect(report.coverageGate.missing).toHaveLength(1);
        const md = await readFile(join(out, "report.md"), "utf8");
        expect(md).toContain("## Coverage gate: FAILED — 3 / 4");
        expect(md).toMatch(/GET\s+\/pets\/\{id\}/);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });

    it("passing tests plus a failing gate: exit 3", async () => {
      const out = await mkdtemp(join(tmpdir(), "qa-api-gate-"));
      try {
        stub(true);
        await runBase(out, "--min-coverage", "80");
        expect(outChunks.join("")).toContain("Coverage gate: FAILED");
        expect(process.exitCode).toBe(3);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });
  });

  it("without the flag no gate line is printed", async () => {
    await run();
    expect(outChunks.join("")).not.toContain("Coverage gate");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
describe("cairn api --base-url guardrails (#196)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubAll = (respond: (init: RequestInit, url: string) => { status: number; body?: string }) => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method });
        const { status, body = "" } = respond(init, url);
        return { status, headers: { get: () => null }, text: async () => body } as unknown as Response;
      }),
    );
    return calls;
  };
  const run = async (out: string, ...extra: string[]) => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync([
      "node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml"),
      "--base-url", "https://api.test", "--out", out, "--rps", "1000", ...extra,
    ]);
  };

  it("without extra flags sends no mutation and reports the skipped ones with their count", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard-"));
    try {
      const calls = stubAll((init) => ({ status: 200, body: init.method === "GET" ? "[]" : "" }));
      await run(out);
      expect(calls.map((c) => c.method).every((m) => m === "GET")).toBe(true);
      const text = outChunks.join("");
      expect(text).toContain("skipped: mutations disabled");
      expect(text).toMatch(/executed 2 · skipped 2 \(mutations disabled: 2\) · blocked 0/);
      expect(text).toContain("request budget: 2/300 used");
      const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as { guardrails: { skipped: Record<string, number> } };
      expect(report.guardrails.skipped).toEqual({ "mutations disabled": 2 });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("--allow-mutations sends them", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard-"));
    try {
      const calls = stubAll((init) => ({ status: init.method === "POST" ? 201 : init.method === "DELETE" ? 204 : 200, body: init.method === "GET" ? "[]" : "" }));
      await run(out, "--allow-mutations");
      expect(calls.map((c) => c.method)).toContain("POST");
      expect(calls.map((c) => c.method)).toContain("DELETE");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("warns that psycho/hacker need --allow-mutations and does not send their mutations", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard-"));
    try {
      const calls = stubAll(() => ({ status: 200, body: "[]" }));
      await run(out, "--adversarial", "psycho,hacker");
      expect(errChunks.join("")).toContain("psycho/hacker styles need --allow-mutations");
      expect(calls.some((c) => c.method !== "GET")).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("--max-requests 3 stops at 3 requests and exits with 4 (not the test-failure code)", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard-"));
    try {
      const calls = stubAll((init, url) => ({ status: init.method === "POST" ? 201 : init.method === "DELETE" ? 204 : 200, body: init.method !== "GET" ? "" : url.endsWith("/pets") ? "[]" : "{}" }));
      await run(out, "--allow-mutations", "--max-requests", "3");
      expect(calls).toHaveLength(3);
      expect(outChunks.join("")).toContain("skipped: budget exhausted");
      expect(process.exitCode).toBe(4);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("a token given by --header is nowhere in the output, the evidence or the reports, and an echoed one is masked", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard-"));
    try {
      stubAll(() => ({ status: 200, body: JSON.stringify(["Bearer TOPSECRET123", "TOPSECRET123"]) }));
      await run(out, "--header", "Authorization: Bearer TOPSECRET123");
      const all = [outChunks.join(""), errChunks.join("")];
      for (const f of ["api-evidence.json", "report.json", "report.md"]) all.push(await readFile(join(out, f), "utf8"));
      expect(all.join("\n")).not.toContain("TOPSECRET123");
      expect(all[2]).toContain("***");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("rejects bad guardrail values before doing any work", async () => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard-"));
    try {
      stubAll(() => ({ status: 200 }));
      await expect(run(out, "--max-requests", "0")).rejects.toThrow(/--max-requests must be a whole number/);
      await expect(run(out, "--rps", "abc")).rejects.toThrow(/--rps must be a number/);
      await expect(run(out, "--allowed-methods", " , ")).rejects.toThrow(/--allowed-methods needs at least one method/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("without --base-url nothing changes: cases are generated and no guardrail section appears", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", join(fixtures, "petstore.yaml")]);
    expect(outChunks.join("")).not.toContain("Guardrails");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("cairn api --base-url guardrails, review follow-ups (#196)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubAll = (respond: (init: RequestInit, url: string) => { status: number; body?: string }) => {
    const calls: { url: string; method?: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, headers: { ...(init.headers as Record<string, string>) } });
        const { status, body = "" } = respond(init, url);
        return { status, headers: { get: () => null }, text: async () => body } as unknown as Response;
      }),
    );
    return calls;
  };
  const okPets = (init: RequestInit, url: string) => ({
    status: init.method === "POST" ? 201 : init.method === "DELETE" ? 204 : 200,
    body: init.method !== "GET" ? "" : url.split("?")[0]!.endsWith("/pets") ? "[]" : "{}",
  });
  const run = async (out: string, spec: string, baseUrl: string, ...extra: string[]) => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", spec, "--base-url", baseUrl, "--out", out, "--rps", "1000", ...extra]);
  };
  const withOut = async (fn: (out: string) => Promise<void>): Promise<void> => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-guard2-"));
    try {
      await fn(out);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };

  it("a run where every case is skipped is not green: exit 5 and a loud message", async () => {
    await withOut(async (out) => {
      const calls = stubAll(() => ({ status: 201 }));
      await run(out, join(fixtures, "post-only.yaml"), "https://api.test");
      expect(calls).toHaveLength(0);
      expect(errChunks.join("")).toContain("No request was sent: all 1 case(s) were skipped or blocked");
      expect(process.exitCode).toBe(5);
    });
  });

  it("--allowed-paths that match nothing is not green either", async () => {
    await withOut(async (out) => {
      const calls = stubAll(okPets);
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test", "--allowed-paths", "/nothing/**");
      expect(calls).toHaveLength(0);
      expect(process.exitCode).toBe(5);
    });
  });

  it("a failed test keeps exit 1 even when the budget ran out (1 beats 4)", async () => {
    await withOut(async (out) => {
      stubAll(() => ({ status: 404 }));
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test", "--max-requests", "1");
      expect(outChunks.join("")).toContain("budget exhausted");
      expect(process.exitCode).toBe(1);
    });
  });

  it("--allowed-methods and --allowed-paths skip the rest with the reason in the report", async () => {
    await withOut(async (out) => {
      const calls = stubAll(okPets);
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test", "--allow-mutations", "--allowed-methods", "get", "--allowed-paths", "/pets");
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.test/pets"]);
      const text = outChunks.join("");
      expect(text).toContain("skipped: not allowed");
      expect(text).toMatch(/executed 1 · skipped 3 \(not allowed: 3\)/);
    });
  });

  it("userinfo in --base-url is moved to a Basic header, never sent in the URL, and never printed or written", async () => {
    await withOut(async (out) => {
      const calls = stubAll(okPets);
      await run(out, join(fixtures, "petstore.yaml"), "https://bob:s3cret-pw@api.test/v1");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.url.startsWith("https://api.test/v1/") && !c.url.includes("@"))).toBe(true);
      expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${Buffer.from("bob:s3cret-pw").toString("base64")}`);
      const all = [outChunks.join(""), errChunks.join("")];
      for (const f of ["api-evidence.json", "report.json", "report.md"]) all.push(await readFile(join(out, f), "utf8"));
      expect(all.join("\n")).not.toContain("s3cret-pw");
      expect(all.join("\n")).not.toContain(Buffer.from("bob:s3cret-pw").toString("base64"));
    });
  });

  it("a secret in a --base-url query string is masked in the log and the reports", async () => {
    await withOut(async (out) => {
      stubAll(okPets);
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test/v1?api_key=QUERYKEY123");
      const all = [outChunks.join(""), errChunks.join("")];
      for (const f of ["api-evidence.json", "report.json", "report.md"]) all.push(await readFile(join(out, f), "utf8"));
      expect(all.join("\n")).not.toContain("QUERYKEY123");
    });
  });

  it("`https://api.test@evil.example` targets evil.example (that is the host), and `//evil.example` is rejected", async () => {
    await withOut(async (out) => {
      const calls = stubAll(okPets);
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test@evil.example/v1");
      expect(calls.every((c) => c.url.startsWith("https://evil.example/v1/"))).toBe(true);
      await expect(run(out, join(fixtures, "petstore.yaml"), "//evil.example/v1")).rejects.toThrow(/--base-url must be an absolute http\(s\) URL/);
    });
  });

  it("warns when a secret is too short to be masked", async () => {
    await withOut(async (out) => {
      stubAll(okPets);
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test", "--header", "X-Api-Key: abc");
      expect(errChunks.join("")).toContain("X-Api-Key is shorter than 4 characters and will NOT be masked");
    });
  });

  it("rejects an absurdly low --rps", async () => {
    await withOut(async (out) => {
      stubAll(okPets);
      await expect(run(out, join(fixtures, "petstore.yaml"), "https://api.test", "--rps", "0.001")).rejects.toThrow(/--rps must be a number of 0.01 or more/);
    });
  });

  it("the token is also absent from every testcases/*.md file", async () => {
    await withOut(async (out) => {
      stubAll((init, url) => ({ ...okPets(init, url), body: JSON.stringify(["TOPSECRET123"]) }));
      await run(out, join(fixtures, "petstore.yaml"), "https://api.test", "--header", "Authorization: Bearer TOPSECRET123");
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(out, "testcases"));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(await readFile(join(out, "testcases", f), "utf8")).not.toContain("TOPSECRET123");
    });
  });
});

describe("cairn api exit-code order: 1 > 3 > 4 > 5", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubOk = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const status = init.method === "POST" ? 201 : init.method === "DELETE" ? 204 : 200;
        const body = init.method !== "GET" ? "" : String(url).endsWith("/pets") ? "[]" : "{}";
        return { status, headers: { get: () => null }, text: async () => body } as unknown as Response;
      }),
    );
  const code = async (spec: string, ...extra: string[]): Promise<number | string | undefined> => {
    const out = await mkdtemp(join(tmpdir(), "qa-api-order-"));
    try {
      const { buildProgram } = await import("../../src/cli/index.js");
      await buildProgram().parseAsync(["node", "cairn", "api", "--spec", join(fixtures, spec), "--base-url", "https://api.test", "--out", out, "--rps", "1000", ...extra]);
      return process.exitCode;
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };

  it("4 alone: the budget ran out and nothing else went wrong", async () => {
    stubOk();
    expect(await code("petstore.yaml", "--allow-mutations", "--max-requests", "3")).toBe(4);
  });

  it("3 beats 4: the skipped case is uncovered, so the gate fails as well", async () => {
    stubOk();
    expect(await code("petstore.yaml", "--allow-mutations", "--max-requests", "3", "--min-coverage", "100")).toBe(3);
  });

  it("3 beats 5: nothing was sent, so nothing is covered and the gate fails", async () => {
    stubOk();
    expect(await code("post-only.yaml", "--min-coverage", "100")).toBe(3);
  });

  it("5 alone: nothing was sent", async () => {
    stubOk();
    expect(await code("post-only.yaml")).toBe(5);
  });

  it("1 beats 3: a failed test wins over the gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }) as unknown as Response));
    expect(await code("petstore.yaml", "--allow-mutations", "--min-coverage", "100")).toBe(1);
  });
});
