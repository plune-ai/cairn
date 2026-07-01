import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestOpenApi, type ApiModel } from "../../src/api/openapi.js";
import { generateApiCases, generateNegativeCases } from "../../src/api/cases.js";

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

describe("multipart/form-data request bodies (API-10, #150)", () => {
  function multipartModel(): ApiModel {
    return model({
      method: "POST",
      path: "/upload",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["multipart/form-data"],
        schema: {
          type: "object",
          required: ["file"],
          properties: { file: { type: "string", format: "binary" }, description: { type: "string" } },
        },
      },
      responses: [{ status: "201" }],
      security: [],
    });
  }

  it("synthesises a format:binary property as real bytes (a Buffer), not the literal string \"string\"", () => {
    const [c] = generateApiCases(multipartModel());
    const body = c!.body as Record<string, unknown>;
    expect(Buffer.isBuffer(body.file)).toBe(true);
    expect((body.file as Buffer).length).toBeGreaterThan(0);
    expect(body.description).toBe("string"); // unaffected — only `format: binary` changes
  });

  it("tags the case with bodyMediaType from the operation's first declared media type", () => {
    const [c] = generateApiCases(multipartModel());
    expect(c!.bodyMediaType).toBe("multipart/form-data");
  });

  it("leaves bodyMediaType as application/json for a plain JSON operation (unchanged default)", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const createPet = generateApiCases(m).find((c) => c.name === "createPet")!;
    expect(createPet.bodyMediaType).toBe("application/json");
  });

  it("leaves bodyMediaType undefined for a bodyless operation", async () => {
    const tiny = await ingestOpenApi(join(fixtures, "tiny.json"));
    const [health] = generateApiCases(tiny);
    expect(health!.bodyMediaType).toBeUndefined();
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

describe("generateNegativeCases — one contract-violation case per operation with something to violate (API-8, #145)", () => {
  it("corrupts a request-body property to the wrong type (createPet: Pet has no required fields, so it violates by type)", async () => {
    const mAll = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const negatives = generateNegativeCases(mAll);

    // getPet/listPets/deletePet have nothing worth violating (no body, no non-path required params).
    expect(negatives).toHaveLength(1);
    const [neg] = negatives;
    expect(neg!.name).toBe("createPet (negative)");
    expect(neg!.type).toBe("Negative");
    expect(neg!.technique).toBe("error-guessing");
    expect(typeof (neg!.body as Record<string, unknown>).id).toBe("number"); // was string — flipped
    expect((neg!.body as Record<string, unknown>).name).toBe("string"); // untouched, still valid
    expect(neg!.expectedStatus).toBe("4XX"); // createPet only declares 201 — generic range fallback
    expect(neg!.expectedSchema).toBeUndefined(); // nothing declared for "4XX" to check against
  });

  it("omits a required non-path param (query/header/cookie) when there's no body to violate", () => {
    const m = model({
      method: "GET",
      path: "/search",
      tags: [],
      parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
      responses: [{ status: "200" }, { status: "400" }],
      security: [],
    });
    const [neg] = generateNegativeCases(m);
    expect(neg!.params.query).toEqual({}); // required "q" dropped
    expect(neg!.expectedStatus).toBe("400"); // the declared 4xx is used, not the generic range
  });

  it("skips an operation with nothing to violate (no body, no non-path required params)", async () => {
    const tiny = await ingestOpenApi(join(fixtures, "tiny.json"));
    expect(generateNegativeCases(tiny)).toEqual([]);
  });

  it("does not try to violate a required PATH param (it would just break routing, not the contract)", () => {
    const m = model({
      method: "GET",
      path: "/items/{id}",
      tags: [],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: [{ status: "200" }],
      security: [],
    });
    expect(generateNegativeCases(m)).toEqual([]);
  });
});
