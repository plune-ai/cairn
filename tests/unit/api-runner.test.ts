import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runApiCases, validateAgainstSchema, type FetchLike, type ResponseLike } from "../../src/api/runner.js";
import { generateApiCases, type ApiCase } from "../../src/api/cases.js";
import { ingestOpenApi } from "../../src/api/openapi.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

/**
 * C1-04 / API-3 (#133): the runner executes generated cases against a base URL and asserts each
 * response (status + schema). Network is injected (`fetch`), never real. Covers: status assertion,
 * schema conformance (valid/invalid), auth/header application, transient retry (#90) then fail, and
 * captured request/response evidence.
 */

/** A canned response, and a fetch that records every call it receives. */
function fakeFetch(responses: Array<ResponseLike | Error>): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

function res(status: number, body: unknown = ""): ResponseLike {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}

function caseOf(over: Partial<ApiCase> = {}): ApiCase {
  return {
    name: "getPet",
    method: "GET",
    path: "/pets/{id}",
    params: { path: { id: "7" }, query: {}, header: {}, cookie: {} },
    expectedStatus: "200",
    ...over,
  };
}

describe("runApiCases — execution + status assertion (a)", () => {
  it("substitutes path/query params, sends the request, and asserts the declared status", async () => {
    const { fetch, calls } = fakeFetch([res(200, { id: "7" })]);
    const c = caseOf({ params: { path: { id: "7" }, query: { detail: "full" }, header: {}, cookie: {} } });
    const [r] = await runApiCases([c], { baseUrl: "https://api.test/v1/", fetch });

    expect(calls[0]!.url).toBe("https://api.test/v1/pets/7?detail=full");
    expect(calls[0]!.init.method).toBe("GET");
    expect(r!.statusOk).toBe(true);
    expect(r!.passed).toBe(true);
    expect(r!.attempts).toBe(1);
  });

  it("fails the status assertion when the code does not match", async () => {
    const { fetch } = fakeFetch([res(404, { error: "nope" })]);
    const [r] = await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch });
    expect(r!.statusOk).toBe(false);
    expect(r!.passed).toBe(false);
    expect(r!.attempts).toBe(1); // 4xx is NOT transient — no retry
  });

  it("sends a JSON body with a content-type for body cases", async () => {
    const { fetch, calls } = fakeFetch([res(201, { id: "x" })]);
    const c = caseOf({ method: "POST", path: "/pets", expectedStatus: "201", body: { name: "Rex" }, params: { path: {}, query: {}, header: {}, cookie: {} } });
    await runApiCases([c], { baseUrl: "https://api.test", fetch });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "Rex" }));
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("multipart/form-data encoding (API-10, #150)", () => {
  it("encodes a multipart case as FormData — a Buffer field becomes a File part, others stringified fields — without forcing JSON content-type", async () => {
    const { fetch, calls } = fakeFetch([res(201, { id: "f1" })]);
    const c = caseOf({
      method: "POST",
      path: "/upload",
      expectedStatus: "201",
      bodyMediaType: "multipart/form-data",
      body: { file: Buffer.from("hello"), description: "a file" },
      params: { path: {}, query: {}, header: {}, cookie: {} },
    });
    const [r] = await runApiCases([c], { baseUrl: "https://api.test", fetch });

    const sentBody = calls[0]!.init.body as FormData;
    expect(sentBody).toBeInstanceOf(FormData);
    expect(sentBody.get("description")).toBe("a file");
    const filePart = sentBody.get("file") as File;
    expect(filePart).toBeInstanceOf(File);
    expect(await filePart.text()).toBe("hello");

    // fetch/undici must generate its own multipart boundary — a manual JSON header would fight it.
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(r!.passed).toBe(true);
  });

  it("still JSON-encodes a case with no bodyMediaType (default, unchanged behaviour)", async () => {
    const { fetch, calls } = fakeFetch([res(201, { id: "x" })]);
    const c = caseOf({ method: "POST", path: "/pets", expectedStatus: "201", body: { name: "Rex" }, params: { path: {}, query: {}, header: {}, cookie: {} } });
    await runApiCases([c], { baseUrl: "https://api.test", fetch });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "Rex" }));
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("ingest → generate → run end to end against a real multipart fixture spec", async () => {
    const m = await ingestOpenApi(join(fixtures, "multipart-upload.yaml"));
    const [c] = generateApiCases(m);
    expect(c!.bodyMediaType).toBe("multipart/form-data");

    const { fetch, calls } = fakeFetch([res(201, { id: "f2" })]);
    const [r] = await runApiCases([c!], { baseUrl: "https://api.test", fetch });

    const sentBody = calls[0]!.init.body as FormData;
    const filePart = sentBody.get("file") as File;
    expect(filePart).toBeInstanceOf(File);
    expect((await filePart.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(r!.passed).toBe(true);
  });
});

describe("response-schema conformance (b)", () => {
  const schema = { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } };

  it("passes when the body conforms to the declared success schema", async () => {
    const { fetch } = fakeFetch([res(200, { id: "7", name: "Rex" })]);
    const [r] = await runApiCases([caseOf({ expectedSchema: schema })], { baseUrl: "https://api.test", fetch });
    expect(r!.schemaOk).toBe(true);
    expect(r!.passed).toBe(true);
  });

  it("fails (with errors) when a required field is missing or mistyped", async () => {
    const { fetch } = fakeFetch([res(200, { id: 7 })]);
    const [r] = await runApiCases([caseOf({ expectedSchema: schema })], { baseUrl: "https://api.test", fetch });
    expect(r!.schemaOk).toBe(false);
    expect(r!.schemaErrors).toEqual(
      expect.arrayContaining([expect.stringContaining("name: required property missing"), expect.stringContaining("expected string, got number")]),
    );
    expect(r!.passed).toBe(false);
  });

  it("flags a non-JSON body when a schema is expected", async () => {
    const { fetch } = fakeFetch([res(200, "<html>not json</html>")]);
    const [r] = await runApiCases([caseOf({ expectedSchema: schema })], { baseUrl: "https://api.test", fetch });
    expect(r!.schemaOk).toBe(false);
    expect(r!.schemaErrors[0]).toMatch(/not valid JSON/);
  });

  it("validateAgainstSchema handles enums, arrays, integers, nullable and composition", () => {
    expect(validateAgainstSchema(["a", "b"], { type: "array", items: { type: "string" } })).toEqual([]);
    expect(validateAgainstSchema([1, "x"], { type: "array", items: { type: "integer" } })).toEqual([expect.stringContaining(".1: expected integer, got string")]);
    expect(validateAgainstSchema("z", { enum: ["a", "b"] })).toEqual([expect.stringContaining("not in enum")]);
    expect(validateAgainstSchema(7, { type: "integer" })).toEqual([]); // integer satisfied by a JSON number
    expect(validateAgainstSchema(null, { type: "string", nullable: true })).toEqual([]);
    expect(validateAgainstSchema(null, { type: "string" })).toEqual([expect.stringContaining("expected string, got null")]);
    expect(validateAgainstSchema({ a: { b: 1 } }, { type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } })).toEqual([expect.stringContaining("$.a.b: expected string")]);
    expect(validateAgainstSchema(5, { oneOf: [{ type: "string" }, { type: "number" }] })).toEqual([]);
    expect(validateAgainstSchema(true, { oneOf: [{ type: "string" }, { type: "number" }] })).toEqual(
      expect.arrayContaining([expect.stringContaining("must match exactly one schema in oneOf")]),
    );
  });

  it("(API-8, #145) enforces keywords the old hand-rolled checker skipped — format/pattern/min/max/additionalProperties", () => {
    expect(validateAgainstSchema("not-an-email", { type: "string", format: "email" })).toEqual([
      expect.stringContaining('must match format "email"'),
    ]);
    expect(validateAgainstSchema("abc", { type: "string", pattern: "^\\d+$" })).toEqual([expect.stringContaining("must match pattern")]);
    expect(validateAgainstSchema(3, { type: "integer", minimum: 5 })).toEqual([expect.stringContaining(">= 5")]);
    expect(validateAgainstSchema(11, { type: "integer", maximum: 10 })).toEqual([expect.stringContaining("<= 10")]);
    expect(validateAgainstSchema({ id: "1", extra: "nope" }, { type: "object", properties: { id: { type: "string" } }, additionalProperties: false })).toEqual([
      expect.stringContaining('unexpected additional property "extra"'),
    ]);
    // valid against every added keyword — no false positives from the upgrade.
    expect(
      validateAgainstSchema(
        { id: "user@example.com" },
        { type: "object", properties: { id: { type: "string", format: "email" } }, additionalProperties: false },
      ),
    ).toEqual([]);
  });

  it("(API-8, #145) compiles a schema with a real circular $ref (swagger-parser dereference) without infinite recursion", () => {
    const pet: { type: string; properties: Record<string, unknown> } = {
      type: "object",
      properties: { id: { type: "string" } },
    };
    pet.properties.friends = { type: "array", items: pet }; // literal object cycle, not a $ref keyword
    expect(validateAgainstSchema({ id: "1", friends: [{ id: "2", friends: [] }] }, pet)).toEqual([]);
    expect(validateAgainstSchema({ id: 1 }, pet)).toEqual([expect.stringContaining("expected string, got number")]);
  });
});

describe("auth / headers application (c)", () => {
  it("applies configured auth headers to every request", async () => {
    const { fetch, calls } = fakeFetch([res(200, {})]);
    await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch, auth: { headers: { Authorization: "Bearer t0ken", "X-Api-Key": "k" } } });
    const sent = calls[0]!.init.headers as Record<string, string>;
    expect(sent["Authorization"]).toBe("Bearer t0ken");
    expect(sent["X-Api-Key"]).toBe("k");
  });

  it("redacts sensitive headers in captured evidence (no secrets on disk/logs)", async () => {
    const { fetch } = fakeFetch([res(200, {})]);
    const [r] = await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch, auth: { headers: { Authorization: "Bearer secret" } } });
    expect(r!.request.headers["Authorization"]).toBe("***");
  });
});

describe("transient recovery then fail (d) — reuses the #90 ladder", () => {
  it("retries on a 5xx and passes once the service recovers", async () => {
    const { fetch, calls } = fakeFetch([res(503), res(503), res(200, {})]);
    const [r] = await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch, baseDelayMs: 0 });
    expect(calls).toHaveLength(3);
    expect(r!.attempts).toBe(3);
    expect(r!.passed).toBe(true);
  });

  it("retries a transient throw (ECONNRESET) and gives up after retries → recorded error, not passed", async () => {
    const { fetch, calls } = fakeFetch([new Error("read ECONNRESET"), new Error("read ECONNRESET"), new Error("read ECONNRESET")]);
    const [r] = await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch, retries: 2, baseDelayMs: 0 });
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(r!.error).toMatch(/ECONNRESET/);
    expect(r!.passed).toBe(false);
    expect(r!.response).toBeUndefined();
  });

  it("does NOT retry a fatal throw (DNS / connection refused)", async () => {
    const { fetch, calls } = fakeFetch([new Error("getaddrinfo ENOTFOUND api.test")]);
    const [r] = await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch, baseDelayMs: 0 });
    expect(calls).toHaveLength(1); // fatal → fail fast
    expect(r!.error).toMatch(/ENOTFOUND/);
  });
});

describe("evidence capture (e)", () => {
  it("captures request + response per case", async () => {
    const { fetch } = fakeFetch([res(200, { id: "7" })]);
    const [r] = await runApiCases([caseOf()], { baseUrl: "https://api.test", fetch });
    expect(r!.url).toBe("https://api.test/pets/7");
    expect(r!.method).toBe("GET");
    expect(r!.response).toEqual({ status: 200, bodyText: JSON.stringify({ id: "7" }), json: { id: "7" } });
  });
});
