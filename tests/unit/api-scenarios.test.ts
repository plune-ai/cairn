import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestOpenApi, type ApiModel } from "../../src/api/openapi.js";
import { generateApiScenarios } from "../../src/api/scenarios.js";

/**
 * C1-04 / API-9 (#146): multi-endpoint scenario chains. `crud-store.yaml` has three resource groups
 * exercising the three generation paths: a full CRUD resource with declared `links` (items), a
 * partial resource (create+read+delete, no update) with no links, relying on the name-match fallback
 * (widgets), and a create-only resource with nothing to chain to (events).
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

async function crudStore(): Promise<ApiModel> {
  return ingestOpenApi(join(fixtures, "crud-store.yaml"));
}

describe("generateApiScenarios — resource grouping + CRUD ordering (a)", () => {
  it("chains a full CRUD resource in create → read → update → delete order", async () => {
    const model = await crudStore();
    const scenarios = generateApiScenarios(model);
    const items = scenarios.find((s) => s.name === "items lifecycle")!;
    expect(items).toBeDefined();
    expect(items.steps.map((c) => c.name)).toEqual(["createItem", "getItem", "updateItem", "deleteItem"]);
    expect(items.technique).toBe("state-transition");
  });

  it("carries the create step's declared `links` for the runner to prefer over the name-match fallback", async () => {
    const model = await crudStore();
    const [create] = generateApiScenarios(model).find((s) => s.name === "items lifecycle")!.steps;
    expect(create!.responseLinks).toBeDefined();
    expect(Object.keys(create!.responseLinks!)).toEqual(["GetItem", "UpdateItem", "DeleteItem"]);
    expect(create!.responseLinks!.GetItem).toEqual({ operationId: "getItem", parameters: { id: "$response.body#/id" } });
  });

  it("chains a partial resource (create+read+delete, no update) in the same order, skipping what's absent", async () => {
    const model = await crudStore();
    const widgets = generateApiScenarios(model).find((s) => s.name === "widgets lifecycle")!;
    expect(widgets.steps.map((c) => c.name)).toEqual(["createWidget", "getWidget", "deleteWidget"]);
    expect(widgets.steps[0]!.responseLinks).toBeUndefined(); // no links declared on this resource
  });

  it("generates no scenario for a create-only resource — nothing to chain to", async () => {
    const model = await crudStore();
    const scenarios = generateApiScenarios(model);
    expect(scenarios.some((s) => s.name.startsWith("events"))).toBe(false);
  });

  it("generates exactly the two chainable resources, in model order", async () => {
    const model = await crudStore();
    const scenarios = generateApiScenarios(model);
    expect(scenarios.map((s) => s.name)).toEqual(["items lifecycle", "widgets lifecycle"]);
  });

  it("each step is a normal happy-path ApiCase — same synthesis as generateApiCases (API-2)", async () => {
    const model = await crudStore();
    const [create] = generateApiScenarios(model).find((s) => s.name === "items lifecycle")!.steps;
    expect(create!.type).toBe("Positive");
    expect(create!.method).toBe("POST");
    expect(create!.body).toEqual({ name: "string" });
    expect(create!.expectedStatus).toBe("201");
  });

  it("a resource with no create op (only item-level ops) is skipped — nothing to seed the chain", () => {
    const model: ApiModel = {
      openapiVersion: "3.0.0",
      tags: [],
      securitySchemes: [],
      endpoints: [
        {
          method: "GET",
          path: "/orphans/{id}",
          tags: [],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: [{ status: "200" }],
          security: [],
          deprecated: false,
        },
      ],
    };
    expect(generateApiScenarios(model)).toEqual([]);
  });
});
