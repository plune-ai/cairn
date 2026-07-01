import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestOpenApi, type ApiModel, type ApiEndpoint } from "../../src/api/openapi.js";
import { generateApiCases, type ApiCase } from "../../src/api/cases.js";
import { computeApiCoverage } from "../../src/api/coverage.js";
import type { ApiCaseResult } from "../../src/api/runner.js";

/**
 * C1-04 / API-6 (#136): spec-vs-tested coverage — a pure set-difference over the ingested model
 * (API-1) and the generated/executed cases (API-2/API-3/API-4). Driven by the real petstore fixture
 * (already used by API-2's own tests) so the partial-coverage case (`getPet`: 200 + 404 declared,
 * only 200 tested) comes from a real spec, not a hand-built one.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

const endpoint = (over: Partial<ApiEndpoint> = {}): ApiEndpoint => ({
  method: "GET",
  path: "/x",
  tags: [],
  parameters: [],
  responses: [{ status: "200" }],
  security: [],
  deprecated: false,
  ...over,
});

const model = (...endpoints: ApiEndpoint[]): ApiModel => ({
  openapiVersion: "3.0.0",
  endpoints,
  tags: [],
  securitySchemes: [],
});

describe("computeApiCoverage — petstore fixture (a, c: covered + partial)", () => {
  it("an operation with one declared response, tested → covered", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const cases = generateApiCases(m);
    const r = computeApiCoverage(m, cases);
    const createPet = r.endpoints.find((e) => e.operationId === "createPet")!;
    expect(createPet.status).toBe("covered");
    expect(createPet.declaredStatuses).toEqual(["201"]);
    expect(createPet.testedStatuses).toEqual(["201"]);
  });

  it("getPet declares 200+404 but the happy-path case only tests 200 → partial", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const cases = generateApiCases(m);
    const r = computeApiCoverage(m, cases);
    const getPet = r.endpoints.find((e) => e.operationId === "getPet")!;
    expect(getPet.status).toBe("partial");
    expect(getPet.declaredStatuses).toEqual(["200", "404"]);
    expect(getPet.testedStatuses).toEqual(["200"]);
    expect(r.partialCount).toBe(1);
  });

  it("summary counts + ratio reconcile with the fixture's 4 operations", async () => {
    const m = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const cases = generateApiCases(m);
    const r = computeApiCoverage(m, cases);
    expect(r.endpointCount).toBe(4);
    expect(r.coveredCount + r.partialCount + r.uncoveredCount).toBe(4);
    expect(r.ratio).toBeCloseTo(r.coveredCount / 4);
  });
});

describe("computeApiCoverage — uncovered + edge cases (b, d, e, f)", () => {
  it("an operation with no matching case at all → uncovered", () => {
    const m = model(endpoint({ operationId: "getX" }));
    const r = computeApiCoverage(m, []); // no cases generated for it
    expect(r.endpoints[0]?.status).toBe("uncovered");
    expect(r.endpoints[0]?.testedStatuses).toEqual([]);
    expect(r.uncoveredCount).toBe(1);
  });

  it("an endpoint in the spec whose case was filtered out (drift) → uncovered, others unaffected", () => {
    const m = model(endpoint({ operationId: "a" }), endpoint({ operationId: "b", path: "/y" }));
    const allCases = generateApiCases(m);
    const onlyA = allCases.filter((c) => c.name === "a"); // simulate "b"'s case having been dropped
    const r = computeApiCoverage(m, onlyA);
    expect(r.endpoints.find((e) => e.operationId === "a")?.status).toBe("covered");
    expect(r.endpoints.find((e) => e.operationId === "b")?.status).toBe("uncovered");
  });

  it("empty spec → ratio 1, no NaN, zero counts", () => {
    const r = computeApiCoverage(model(), []);
    expect(r.endpointCount).toBe(0);
    expect(r.ratio).toBe(1);
    expect(r.coveredCount).toBe(0);
    expect(r.endpoints).toEqual([]);
  });

  it("carries the spec's `deprecated` flag through to the coverage row", () => {
    const m = model(endpoint({ operationId: "old", deprecated: true }));
    const r = computeApiCoverage(m, []);
    expect(r.endpoints[0]?.deprecated).toBe(true);
  });

  it("an operation with zero declared responses is vacuously covered (nothing to miss)", () => {
    const m = model(endpoint({ operationId: "noResponses", responses: [] }));
    const r = computeApiCoverage(m, []); // no case either — still nothing to be "uncovered" against
    expect(r.endpoints[0]?.status).toBe("covered");
    expect(r.coveredCount).toBe(1);
  });
});

describe("computeApiCoverage — result overlay (g)", () => {
  const result = (over: Partial<ApiCaseResult> = {}): ApiCaseResult => ({
    name: "a",
    method: "GET",
    url: "https://api.test/x",
    request: { headers: {} },
    attempts: 1,
    expectedStatus: "200",
    statusOk: true,
    schemaOk: true,
    schemaErrors: [],
    passed: true,
    ...over,
  });

  it("no results supplied (cases-only run) → passed is undefined, not false", () => {
    const m = model(endpoint({ operationId: "a" }));
    const cases: ApiCase[] = generateApiCases(m);
    const r = computeApiCoverage(m, cases);
    expect(r.endpoints[0]?.passed).toBeUndefined();
  });

  it("a passing result → passed: true on the covering operation", () => {
    const m = model(endpoint({ operationId: "a" }));
    const cases = generateApiCases(m);
    const r = computeApiCoverage(m, cases, [result({ passed: true })]);
    expect(r.endpoints[0]?.passed).toBe(true);
  });

  it("a failing result → passed: false (coverage ≠ correctness)", () => {
    const m = model(endpoint({ operationId: "a" }));
    const cases = generateApiCases(m);
    const r = computeApiCoverage(m, cases, [result({ passed: false })]);
    expect(r.endpoints[0]?.status).toBe("covered"); // a case targets it — still "tested"
    expect(r.endpoints[0]?.passed).toBe(false); // but it didn't pass
  });

  it("uncovered operation with results present → passed stays undefined (nothing ran against it)", () => {
    const m = model(endpoint({ operationId: "a" }));
    const r = computeApiCoverage(m, [], [result({ name: "other" })]);
    expect(r.endpoints[0]?.status).toBe("uncovered");
    expect(r.endpoints[0]?.passed).toBeUndefined();
  });
});
