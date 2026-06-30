import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fails cleanly (stderr + exit 1, no throw) on a malformed spec", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", "--spec", join(fixtures, "malformed.yaml")]);
    expect(errChunks.join("")).toMatch(/✗ Could not read OpenAPI spec/);
    expect(process.exitCode).toBe(1);
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
