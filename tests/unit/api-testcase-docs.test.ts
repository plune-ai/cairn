import { describe, it, expect } from "vitest";
import { buildApiTestCaseDocs } from "../../src/api/testcase-docs.js";
import type { ApiCase } from "../../src/api/cases.js";
import type { ApiCaseResult } from "../../src/api/runner.js";

/**
 * C1-04 / API-5 (#135): ATC emission for API cases + the provenance-checked status rule that aligns
 * with BORROW-04 (#91) — a case may only read "Passed" when backed by a real, matching result.
 */
const c = (over: Partial<ApiCase> = {}): ApiCase => ({
  name: "getPet",
  method: "GET",
  path: "/pets/{id}",
  params: { path: { id: "string" }, query: {}, header: {}, cookie: {} },
  expectedStatus: "200",
  technique: "equivalence-partitioning",
  rationale: "Happy-path case in the valid equivalence class for GET /pets/{id}: asserts 200.",
  ...over,
});

const result = (over: Partial<ApiCaseResult> = {}): ApiCaseResult => ({
  name: "getPet",
  method: "GET",
  url: "https://api.test/pets/1",
  request: { headers: {} },
  attempts: 1,
  expectedStatus: "200",
  statusOk: true,
  schemaOk: true,
  schemaErrors: [],
  passed: true,
  ...over,
});

describe("buildApiTestCaseDocs — ATC emission + provenance (#91-aligned)", () => {
  it("numbers cases ATC-<suite>-NNN in input order", () => {
    const r = buildApiTestCaseDocs([c({ name: "a" }), c({ name: "b" })], undefined, "DEMO-API");
    expect(r.docs.map((d) => d.id)).toEqual(["ATC-DEMO-API-001", "ATC-DEMO-API-002"]);
  });

  it("no results (cases-only run) → status is 'Not run', never a fabricated pass", () => {
    const r = buildApiTestCaseDocs([c()], undefined, "DEMO-API");
    expect(r.docs[0]?.md).toContain("status: ❌ Not run");
  });

  it("a matching passed result → status Passed", () => {
    const r = buildApiTestCaseDocs([c()], [result({ passed: true })], "DEMO-API");
    expect(r.docs[0]?.md).toContain("status: ✅ Passed");
  });

  it("a matching failed result → status Failed (never Passed without evidence)", () => {
    const r = buildApiTestCaseDocs([c()], [result({ passed: false, statusOk: false })], "DEMO-API");
    expect(r.docs[0]?.md).toContain("status: ❌ Failed");
  });

  it("a case absent from the results (name mismatch) is never marked Passed", () => {
    const r = buildApiTestCaseDocs([c({ name: "other" })], [result({ name: "getPet", passed: true })], "DEMO-API");
    expect(r.docs[0]?.md).toContain("status: ❌ Not run");
  });

  it("carries the technique/rationale methodology tag into the doc", () => {
    const r = buildApiTestCaseDocs([c()], undefined, "DEMO-API");
    expect(r.docs[0]?.md).toContain("technique: equivalence-partitioning");
    expect(r.docs[0]?.md).toContain(c().rationale);
  });
});
