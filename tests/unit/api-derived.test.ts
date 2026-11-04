import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ingestOpenApi } from "../../src/api/openapi.js";
import { deriveSpec, detectSpecFormat } from "../../src/api/collection.js";
import {
  DERIVED_KEY,
  DERIVED_SPEC_FILE,
  DerivedSpecBuilder,
  isApiTraffic,
  mergeSchema,
  schemaOf,
  templatePath,
  writeDerivedSpec,
} from "../../src/api/derived.js";

/**
 * #228: `cairn api --spec` takes a Postman collection (v2.1) or a HAR file. Both are turned into OpenAPI 3.x that the
 * normal ingest reads, what was inferred from examples is marked `x-cairn-derived: true`, and the file written holds
 * none of the fixture's tokens.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");
const postmanPath = join(fixtures, "collection.postman.json");
const harPath = join(fixtures, "session.har");

/** Every made-up credential the two fixtures carry, in headers, cookies, queries, bodies, variables and paths. */
const TOKENS = [
  "FAKE-postman-bearer-7c1d9e",
  "FAKE-query-apikey-55aa31",
  "FAKE-xapikey-0042zz",
  "FAKE-postman-session-91be2d",
  "FAKE-postman-cookie-3f8a1b",
  "FAKE-Pa55word!",
  "FAKE-postman-resp-token-abc123",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlLXVzZXIifQ.FAKEsigFIXTURE0001xyz",
  "FAKEsigFIXTURE0001xyz",
  "FAKE-har-session-7f3a9c",
  "FAKEcsrf8812q",
  "FAKE-har-newsession-91be2d",
  "FAKE-har-resp-token-abc123",
  "FAKE-har-qtoken-ZZ81x",
  "FAKE-har-xapikey-0042zz",
  "9f86d081884c7d659a2feaa0c55ad015",
];

const sigs = (m: { endpoints: { method: string; path: string }[] }): string[] =>
  m.endpoints.map((e) => `${e.method} ${e.path}`).sort();

async function writeAndIngest(text: string): Promise<{ file: string; saved: string; model: Awaited<ReturnType<typeof ingestOpenApi>> }> {
  const derived = deriveSpec(text);
  if (!derived) throw new Error("not derived");
  const dir = await mkdtemp(join(tmpdir(), "cairn-derived-"));
  try {
    const file = await writeDerivedSpec(dir, derived.doc, derived.secrets);
    const saved = await readFile(file, "utf8");
    const model = await ingestOpenApi(file);
    return { file, saved, model };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("detectSpecFormat (#228)", () => {
  it("tells a Postman collection, a HAR and anything else apart by content", async () => {
    expect(detectSpecFormat(await readFile(postmanPath, "utf8"))).toBe("postman");
    expect(detectSpecFormat(await readFile(harPath, "utf8"))).toBe("har");
    expect(detectSpecFormat(await readFile(join(fixtures, "tiny.json"), "utf8"))).toBe("openapi");
    expect(detectSpecFormat(await readFile(join(fixtures, "petstore.yaml"), "utf8"))).toBe("openapi");
    expect(detectSpecFormat("not json at all {")).toBe("openapi");
  });

  it("refuses a Postman v1 collection with a clear message", () => {
    expect(() => deriveSpec(JSON.stringify({ id: "x", name: "Old", requests: [{ url: "http://a/b", method: "GET" }] }))).toThrow(
      /Postman collection v1 is not supported/,
    );
  });
});

describe("Postman collection → OpenAPI (#228)", () => {
  it("is accepted by ingestOpenApi, with the collection's endpoints and methods", async () => {
    const { model, file } = await writeAndIngest(await readFile(postmanPath, "utf8"));
    expect(file.endsWith(DERIVED_SPEC_FILE)).toBe(true);
    expect(model.title).toBe("Projects API");
    expect(sigs(model)).toEqual([
      "DELETE /projects/{projectId}",
      "GET /projects",
      "GET /projects/{projectId}",
      "GET /projects/{projectId}/tasks/{taskId}",
      "PATCH /projects/{projectId}",
      "POST /auth/login",
      "POST /projects",
    ]);
    const get = model.endpoints.find((e) => e.method === "GET" && e.path === "/projects/{projectId}")!;
    expect(get.summary).toBe("Get project");
    expect(get.tags).toEqual(["Projects"]);
    expect(get.parameters).toContainEqual({ name: "projectId", in: "path", required: true, schema: { type: "string" } });
    expect(get.responses.map((r) => r.status).sort()).toEqual(["200", "404"]);
    const list = model.endpoints.find((e) => e.method === "GET" && e.path === "/projects")!;
    expect(list.parameters.map((p) => `${p.in}:${p.name}`).sort()).toEqual(["query:api_key", "query:page"]);
    const create = model.endpoints.find((e) => e.method === "POST" && e.path === "/projects")!;
    expect(create.requestBody?.mediaTypes).toEqual(["application/json"]);
    expect(create.requestBody?.schema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" }, public: { type: "boolean" } },
      [DERIVED_KEY]: true,
    });
    const login = model.endpoints.find((e) => e.path === "/auth/login")!;
    expect(login.requestBody?.mediaTypes).toEqual(["application/x-www-form-urlencoded"]);
  });

  it("marks every operation and every inferred schema x-cairn-derived", async () => {
    const derived = deriveSpec(await readFile(postmanPath, "utf8"))!;
    const doc = derived.doc as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const ops = Object.values(doc.paths).flatMap((item) => Object.values(item));
    expect(ops.length).toBe(7);
    for (const op of ops) expect(op[DERIVED_KEY]).toBe(true);
    const schemaOfList = (doc.paths["/projects"]!.get as { responses: Record<string, { content: Record<string, { schema: unknown }> }> })
      .responses["200"]!.content["application/json"]!.schema;
    expect(schemaOfList).toMatchObject({ type: "array", [DERIVED_KEY]: true, items: { type: "object" } });
  });

  it("holds none of the collection's tokens in the saved openapi.derived.json", async () => {
    const { saved } = await writeAndIngest(await readFile(postmanPath, "utf8"));
    for (const t of TOKENS) expect(saved, t).not.toContain(t);
  });
});

describe("HAR → OpenAPI (#228)", () => {
  it("is accepted by ingestOpenApi: API requests only, ids folded into path parameters", async () => {
    const { model } = await writeAndIngest(await readFile(harPath, "utf8"));
    expect(sigs(model)).toEqual([
      "DELETE /api/projects/{id}",
      "GET /api/me",
      "GET /api/projects",
      "GET /api/projects/{id}",
      "GET /api/projects/{projectId}/tasks/{taskId}",
      "GET /api/reset/{id}",
      "POST /api/projects",
      "POST /api/session",
    ]);
    const one = model.endpoints.find((e) => e.method === "GET" && e.path === "/api/projects/{id}")!;
    // Two examples merged: `owner` is an object once and null once; `id`, `name` and `public` are in both.
    expect(one.responses[0]!.schema).toMatchObject({
      type: "object",
      required: ["id", "name", "public", "owner"],
      properties: { id: { type: "integer" }, owner: { type: "object", nullable: true } },
    });
    expect(one.parameters).toContainEqual({ name: "id", in: "path", required: true, schema: { type: "integer" } });
    expect(model.endpoints.find((e) => e.method === "DELETE")!.responses.map((r) => r.status)).toEqual(["204"]);
    expect(model.endpoints.find((e) => e.path === "/api/me")!.parameters.map((p) => p.name)).toEqual(["access_token"]);
  });

  it("names the HAR's origin as the server and leaves other origins out", async () => {
    const derived = deriveSpec(await readFile(harPath, "utf8"))!;
    expect((derived.doc as { servers?: { url: string }[] }).servers).toEqual([{ url: "https://app.example.test" }]);
    expect(JSON.stringify(derived.doc)).not.toContain("analytics.example-tracker.test");
    expect(derived.notes.join("\n")).toMatch(/1 request to another origin left out/);
  });

  it("holds none of the HAR's tokens or cookies in the saved openapi.derived.json", async () => {
    const { saved } = await writeAndIngest(await readFile(harPath, "utf8"));
    for (const t of TOKENS) expect(saved, t).not.toContain(t);
    expect(saved).not.toMatch(/authorization|set-cookie|"cookie"/i);
  });
});

describe("the shared pieces (#228, reused by #229)", () => {
  it("templatePath folds ids and credential-shaped segments, and keeps named parameters", () => {
    expect(templatePath("/projects/123")).toEqual({ path: "/projects/{id}", params: [{ name: "id", integer: true }] });
    expect(templatePath("/projects/123/tasks/9").path).toBe("/projects/{projectId}/tasks/{taskId}");
    expect(templatePath("/users/3f2b9c1e-9a7d-4c11-8b2e-1d2f3a4b5c6d").path).toBe("/users/{id}");
    expect(templatePath("/reset/‹v›").path).toBe("/reset/{id}");
    expect(templatePath("/projects/:projectId/tasks/{{taskId}}").path).toBe("/projects/{projectId}/tasks/{taskId}");
    expect(templatePath("/v2/users/me").path).toBe("/v2/users/me");
  });

  it("schemaOf / mergeSchema keep types and keys, never values", () => {
    const s = mergeSchema(schemaOf({ a: 1, b: "secret-value", c: [true] }), schemaOf({ a: 2.5, c: [], d: null }));
    expect(s).toEqual({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "string" }, c: { type: "array", items: { type: "boolean" } }, d: { nullable: true } },
      required: ["a", "c"],
    });
    expect(JSON.stringify(s)).not.toContain("secret-value");
  });

  it("isApiTraffic leaves pages, scripts, styles, images and fonts out", () => {
    expect(isApiTraffic({ url: "https://a.test/api/x", resourceType: "fetch" })).toBe(true);
    expect(isApiTraffic({ url: "https://a.test/api/x", mimeType: "application/json" })).toBe(true);
    expect(isApiTraffic({ url: "https://a.test/app.js", resourceType: "script" })).toBe(false);
    expect(isApiTraffic({ url: "https://a.test/logo.png" })).toBe(false);
    expect(isApiTraffic({ url: "https://a.test/f.woff2", mimeType: "font/woff2" })).toBe(false);
    expect(isApiTraffic({ url: "https://a.test/", resourceType: "document" })).toBe(false);
    expect(isApiTraffic({ url: "https://a.test/x", mimeType: "text/css" })).toBe(false);
  });

  it("collects every credential a HAR carries, so the writer can scrub it from the file", async () => {
    const derived = deriveSpec(await readFile(harPath, "utf8"))!;
    for (const t of TOKENS.filter((t) => /har|eyJ|csrf|Pa55/.test(t) && t !== "FAKEsigFIXTURE0001xyz")) {
      expect(derived.secrets, t).toContain(t);
    }
  });

  it("writeDerivedSpec scrubs a secret that rode in a name, raw or JSON-escaped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-derived-"));
    try {
      const doc = { openapi: "3.0.3", info: { title: 'Login with FAKE-tok-9z8y7x and "q"FAKE"q', version: "1" }, paths: {} };
      const file = await writeDerivedSpec(dir, doc, ["FAKE-tok-9z8y7x", '"q"FAKE"q']);
      const saved = await readFile(file, "utf8");
      expect(saved).not.toContain("FAKE-tok-9z8y7x");
      expect(saved).not.toContain('\\"q\\"FAKE');
      expect(saved).toContain("‹redacted›");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the builder merges the same operation seen twice and marks it derived", () => {
    const b = new DerivedSpecBuilder();
    b.add({ method: "get", path: "/projects/1", status: 200, response: { contentType: "application/json", body: { id: 1 } } });
    b.add({ method: "GET", path: "/projects/2", status: 404 });
    const doc = b.toOpenApi({ title: "T" }) as { openapi: string; paths: Record<string, { get: Record<string, unknown> }> };
    expect(doc.openapi).toBe("3.0.3");
    expect(Object.keys(doc.paths)).toEqual(["/projects/{id}"]);
    const op = doc.paths["/projects/{id}"]!.get;
    expect(op[DERIVED_KEY]).toBe(true);
    expect(Object.keys(op.responses as object)).toEqual(["200", "404"]);
  });
  it("an e-mail address in a path segment becomes a parameter; plain words stay, ids still fold", () => {
    expect(templatePath("/api/users/alice.smith@example.com/avatar")).toEqual({ path: "/api/users/{id}/avatar", params: [{ name: "id" }] });
    expect(templatePath("/api/users/alice.smith%40example.com").path).toBe("/api/users/{id}");
    expect(templatePath("/api/users/me").path).toBe("/api/users/me");
    const b = new DerivedSpecBuilder();
    b.add({ method: "GET", path: "/users/42", status: 200 });
    b.add({ method: "GET", path: "/users/43", status: 200 });
    b.add({ method: "GET", path: "/users/carol@example.com", status: 200 });
    b.add({ method: "GET", path: "/users/me", status: 200 });
    const doc = b.toOpenApi({ title: "T" }) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).sort()).toEqual(["/users/me", "/users/{id}"]);
    expect(JSON.stringify(doc)).not.toContain("carol@example.com");
  });

  it("an object keyed by e-mail addresses or credential-shaped keys is a map, never named properties", () => {
    const byMail = schemaOf({ "bob.jones@example.com": { role: "admin" }, "carol@example.com": { role: "viewer", since: 2020 } });
    expect(byMail).toEqual({ type: "object", additionalProperties: { type: "object", properties: { role: { type: "string" }, since: { type: "integer" } }, required: ["role"] } });
    expect(schemaOf({ FAKEtok3n4b5c6d7: 1, FAKEtok3n4b5c6d8: 2 })).toEqual({ type: "object", additionalProperties: { type: "integer" } });
    // A map merged with another example stays a map; ordinary keys stay properties.
    expect(mergeSchema(byMail, schemaOf({ "dave@example.com": { role: "x" } }))).toMatchObject({ type: "object", additionalProperties: { type: "object" } });
    expect(schemaOf({ id: 1, email: "x@y.test" })).toEqual({ type: "object", properties: { id: { type: "integer" }, email: { type: "string" } }, required: ["id", "email"] });
  });

  it("e-mail addresses in a Postman collection's or a HAR's paths and bodies never reach the file", async () => {
    const pm = {
      info: { name: "People", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [{ name: "Avatar", request: { method: "GET", url: "https://app.example.test/api/users/alice.smith@example.com/avatar" }, response: [{ code: 200, header: [{ key: "Content-Type", value: "application/json" }], body: JSON.stringify({ "bob.jones@example.com": { role: "admin" } }) }] }],
    };
    const har = {
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://app.example.test/api/users/carol@example.com", headers: [] },
            response: { status: 200, headers: [], content: { mimeType: "application/json", text: JSON.stringify({ "dave@example.com": { role: "viewer" } }) } },
          },
        ],
      },
    };
    for (const [text, path] of [[JSON.stringify(pm), "/api/users/{id}/avatar"], [JSON.stringify(har), "/api/users/{id}"]] as const) {
      const { saved, model } = await writeAndIngest(text);
      for (const mail of ["alice.smith@example.com", "bob.jones@example.com", "carol@example.com", "dave@example.com"]) expect(saved, mail).not.toContain(mail);
      expect(model.endpoints.map((e) => e.path)).toContain(path);
    }
  });
});
