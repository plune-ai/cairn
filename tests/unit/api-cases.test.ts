import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestOpenApi, type ApiModel } from "../../src/api/openapi.js";
import { generateApiCases } from "../../src/api/cases.js";

/**
 * C1-04 / API-2 (#132): baseline happy-path case generation. The synthesis is pure/deterministic
 * (no LLM, no network), so we drive it straight from real-ingested specs and from hand-built models
 * for the schema-keyword edge cases.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

/** Tiny ApiModel builder so we can exercise one schema keyword at a time. */
function model(...endpoints: ApiModel["endpoints"]): ApiModel {
  return { openapiVersion: "3.0.0", endpoints, tags: [], securitySchemes: [] };
}

describe("generateApiCases — one case per operation (a)", () => {
  it("emits exactly one case per ingested operation, with valid params and body", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const cases = generateApiCases(m);

    expect(cases).toHaveLength(m.endpoints.length); // 4 operations → 4 cases

    // GET /pets/{id}: the required path param is synthesised; nothing else.
    const getPet = cases.find((c) => c.name === "getPet")!;
    expect(getPet.params.path).toEqual({ id: "string" });
    expect(getPet.body).toBeUndefined();

    // POST /pets carries a body synthesised from the Pet schema (cyclic `friends` → []).
    const createPet = cases.find((c) => c.name === "createPet")!;
    expect(createPet.body).toEqual({ id: "string", name: "string", friends: [] });
    expect(createPet.expectedStatus).toBe("201");
  });

  it("omits optional params (nominal happy-path) — listPets.limit is not sent", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const listPets = generateApiCases(m).find((c) => c.name === "listPets")!;
    expect(listPets.params.query).toEqual({});
    expect(listPets.expectedStatus).toBe("200");
  });
});

describe("respects required / enum / types / example / format (b)", () => {
  it("prefers example, then enum, then type/format", () => {
    const m = model({
      method: "POST",
      path: "/x",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        schema: {
          type: "object",
          required: ["status", "count"],
          properties: {
            id: { type: "string", example: "abc-123" },
            status: { type: "string", enum: ["active", "archived"] },
            count: { type: "integer", minimum: 5 },
            ok: { type: "boolean" },
            email: { type: "string", format: "email" },
          },
        },
      },
      responses: [{ status: "200" }],
      security: [],
    });
    expect(generateApiCases(m)[0].body).toEqual({
      id: "abc-123", // example wins
      status: "active", // first enum
      count: 5, // minimum
      ok: true,
      email: "user@example.com", // format
    });
  });

  it("keeps a required field present even when its schema yields nothing", () => {
    const m = model({
      method: "POST",
      path: "/x",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        schema: { type: "object", required: ["mystery"], properties: { mystery: {} } },
      },
      responses: [{ status: "200" }],
      security: [],
    });
    expect(generateApiCases(m)[0].body).toEqual({ mystery: null });
  });

  it("resolves allOf (merge) and oneOf (first branch)", () => {
    const m = model({
      method: "POST",
      path: "/x",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        schema: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "integer" } } },
          ],
        },
      },
      responses: [{ status: "200" }],
      security: [],
    });
    expect(generateApiCases(m)[0].body).toEqual({ a: "string", b: 0 });
  });
});

describe("determinism (c)", () => {
  it("same model → identical synthesised cases across runs", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    // expectedSchema is a passthrough pointer to the (possibly cyclic) model schema; the *synthesised*
    // output — name/params/body/status — is what must be byte-stable, so compare that projection.
    const project = (m2: ApiModel) =>
      JSON.stringify(generateApiCases(m2).map((c) => ({ ...c, expectedSchema: undefined })));
    expect(project(m)).toEqual(project(m));
  });
});

describe("no body / multiple responses (d)", () => {
  it("a bodyless op has no body and picks the lowest 2xx as success", async () => {
    const tiny = await ingestOpenApi(join(fixtures, "tiny.json"));
    const [health] = generateApiCases(tiny);
    expect(health.body).toBeUndefined();
    expect(health.expectedStatus).toBe("200");
  });

  it("with several declared responses, the lowest 2xx is the expected success", () => {
    const m = model({
      method: "GET",
      path: "/x",
      tags: [],
      parameters: [],
      responses: [{ status: "404" }, { status: "204" }, { status: "200" }, { status: "500" }],
      security: [],
    });
    expect(generateApiCases(m)[0].expectedStatus).toBe("200");
  });

  it("falls back to `default` when no 2xx is declared", () => {
    const m = model({
      method: "GET",
      path: "/x",
      tags: [],
      parameters: [],
      responses: [{ status: "404" }, { status: "default" }],
      security: [],
    });
    expect(generateApiCases(m)[0].expectedStatus).toBe("default");
  });
});
