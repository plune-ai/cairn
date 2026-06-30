import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestOpenApi } from "../../src/api/openapi.js";

/**
 * C1-04 / API-1 (#22): OpenAPI ingest → internal endpoint model.
 * All fixtures are local files (no network): YAML 3.0 (+ $ref, circular $ref, path-level params,
 * security override) and JSON 3.1; malformed / unsupported specs surface a clean error.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

describe("ingestOpenApi", () => {
  it("parses a YAML 3.0 spec into the endpoint model (methods, paths, params, security, tags)", async () => {
    const model = await ingestOpenApi(join(fixtures, "petstore.yaml"));

    expect(model.title).toBe("Pet Store");
    expect(model.version).toBe("1.2.0");
    expect(model.openapiVersion).toBe("3.0.3");
    expect(model.tags).toEqual(["pets", "store"]); // distinct, sorted
    expect(model.securitySchemes).toEqual(["apiKey"]);

    // 4 endpoints across 2 paths.
    const sig = model.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(sig).toEqual(["DELETE /pets/{id}", "GET /pets", "GET /pets/{id}", "POST /pets"]);

    const getPet = model.endpoints.find((e) => e.operationId === "getPet")!;
    // path-level `id` param is merged onto the operation.
    expect(getPet.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
    // $ref response schema is dereferenced (concrete object, not a $ref).
    const ok = getPet.responses.find((r) => r.status === "200")!;
    expect((ok.schema as { type?: string }).type).toBe("object");

    // global security applies; the operation-level `security: []` makes DELETE explicitly public.
    expect(model.endpoints.find((e) => e.operationId === "listPets")!.security).toEqual(["apiKey"]);
    expect(model.endpoints.find((e) => e.operationId === "deletePet")!.security).toEqual([]);

    // request body is captured with its media type.
    const createPet = model.endpoints.find((e) => e.operationId === "createPet")!;
    expect(createPet.requestBody?.required).toBe(true);
    expect(createPet.requestBody?.mediaTypes).toEqual(["application/json"]);
  });

  it("parses a JSON 3.1 spec", async () => {
    const model = await ingestOpenApi(join(fixtures, "tiny.json"));
    expect(model.openapiVersion).toBe("3.1.0");
    expect(model.endpoints).toHaveLength(1);
    expect(model.endpoints[0]).toMatchObject({ method: "GET", path: "/health", operationId: "health", tags: ["ops"] });
    expect(model.tags).toEqual(["ops"]);
  });

  it("does not crash on a circular $ref (recursive schema)", async () => {
    const model = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const created = model.endpoints.find((e) => e.operationId === "createPet")!;
    // Pet.friends → array of Pet (cycle). The cycle is resolved to an object reference, not thrown.
    const schema = created.requestBody?.schema as { properties?: { friends?: unknown } };
    expect(schema.properties?.friends).toBeDefined();
  });

  it("rejects a malformed spec with a clear error (no crash)", async () => {
    await expect(ingestOpenApi(join(fixtures, "malformed.yaml"))).rejects.toThrow(/Could not read OpenAPI spec/);
  });

  it("rejects an unsupported (Swagger 2.0) spec with a clear error", async () => {
    await expect(ingestOpenApi(join(fixtures, "swagger2.json"))).rejects.toThrow(/Swagger\/OpenAPI 2\.0/);
  });

  it("rejects a missing file with a clear error", async () => {
    await expect(ingestOpenApi(join(fixtures, "nope.yaml"))).rejects.toThrow(/Could not read OpenAPI spec/);
  });
});
