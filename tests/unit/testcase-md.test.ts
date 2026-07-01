import { describe, it, expect } from "vitest";
import {
  renderTestCaseMd,
  renderApiTestCaseMd,
  mapPriority,
  parseTestCaseMd,
  parseApiTestCaseMd,
  type TestCaseDoc,
  type ApiTestCaseDoc,
} from "../../src/artifacts/testcase-md.js";
import type { TestCase } from "../../src/design/index.js";
import type { ApiCase } from "../../src/api/cases.js";

const tc: TestCase = {
  id: "tc-1",
  title: "Генерація CV через вкладку Text",
  technique: "exploratory",
  kind: "active",
  type: "Positive",
  execution: "auto",
  preconditions: ["Користувач залогінений", "Відкрита сторінка Generate CV"],
  steps: ["Перейти на Generate CV", 'Натиснути "Generate CV"'],
  expected: "Згенероване CV доступне",
  priority: "high",
  elementRefs: ["e6"],
};

const doc: TestCaseDoc = {
  id: "ATC-GENERATE-UI-001",
  suite: "GENERATE-UI",
  status: "❌ Not implemented",
  automationPath: "tests/ui/generate-ui/atc-generate-ui-001.spec.ts",
  selectors: [{ label: "Кнопка генерації", locator: "page.getByRole('button', { name: 'Generate CV' })" }],
  traceability: [{ source: "Checklist", reference: "TC-02" }],
};

describe("renderTestCaseMd (ATC format)", () => {
  it("renders frontmatter + sections in the user's format", () => {
    const md = renderTestCaseMd(tc, doc);
    expect(md).toContain("id: ATC-GENERATE-UI-001");
    expect(md).toContain('title: "Генерація CV через вкладку Text"');
    expect(md).toContain("suite: GENERATE-UI");
    expect(md).toContain("priority: P1"); // high → P1
    expect(md).toContain("type: Positive");
    expect(md).toContain("automation: tests/ui/generate-ui/atc-generate-ui-001.spec.ts");
    expect(md).toContain("# ATC-GENERATE-UI-001: Генерація CV через вкладку Text");
    expect(md).toContain("## Preconditions");
    expect(md).toContain("- Користувач залогінений");
    expect(md).toContain("## Steps");
    expect(md).toContain('1. Перейти на Generate CV');
    expect(md).toContain('2. Натиснути "Generate CV"');
    expect(md).toContain("## Expected Result");
    expect(md).toContain("- Згенероване CV доступне");
    expect(md).toContain("## Selectors");
    expect(md).toContain("page.getByRole('button', { name: 'Generate CV' })");
    expect(md).toContain("## Traceability");
    expect(md).toContain("| Checklist | TC-02 |");
  });

  it("mapPriority: critical/high→P1, medium→P2, low→P3", () => {
    expect(mapPriority("critical")).toBe("P1");
    expect(mapPriority("high")).toBe("P1");
    expect(mapPriority("medium")).toBe("P2");
    expect(mapPriority("low")).toBe("P3");
  });

  it("parseTestCaseMd: round-trip from the renderer (title/steps/expected/selectors)", () => {
    const parsed = parseTestCaseMd(renderTestCaseMd(tc, doc));
    expect(parsed.title).toBe("Генерація CV через вкладку Text");
    expect(parsed.steps).toEqual(["Перейти на Generate CV", 'Натиснути "Generate CV"']);
    expect(parsed.expected).toEqual(["Згенероване CV доступне"]);
    expect(parsed.selectors).toEqual([
      { label: "Кнопка генерації", locator: "page.getByRole('button', { name: 'Generate CV' })" },
    ]);
    expect(parsed.id).toBe("ATC-GENERATE-UI-001"); // id from frontmatter
    expect(parsed.execution).toBe("auto");
  });

  it("manual case → execution: manual + status Manual; parse sees this (for the automate filter)", () => {
    const manualTc: TestCase = { ...tc, execution: "manual" };
    const manualDoc: TestCaseDoc = { ...doc, id: "MTC-GENERATE-UI-001", status: "📋 Manual" };
    const md = renderTestCaseMd(manualTc, manualDoc);
    expect(md).toContain("execution: manual");
    expect(md).toContain("status: 📋 Manual");
    const parsed = parseTestCaseMd(md);
    expect(parsed.id).toBe("MTC-GENERATE-UI-001");
    expect(parsed.execution).toBe("manual");
  });
});

const apiCase: ApiCase = {
  name: "createPet",
  method: "POST",
  path: "/pets",
  operationId: "createPet",
  params: { path: {}, query: {}, header: {}, cookie: {} },
  body: { name: "string" },
  expectedStatus: "201",
  expectedSchema: { type: "object" },
  technique: "equivalence-partitioning",
  rationale: "Happy-path case in the valid equivalence class for POST /pets: asserts 201.",
};

const apiDoc: ApiTestCaseDoc = { id: "ATC-PETSTORE-API-001", suite: "PETSTORE-API", status: "✅ Passed" };

describe("renderApiTestCaseMd (ATC format, API-5 #135)", () => {
  it("renders frontmatter + methodology tag + request/expected sections", () => {
    const md = renderApiTestCaseMd(apiCase, apiDoc);
    expect(md).toContain("id: ATC-PETSTORE-API-001");
    expect(md).toContain('title: "createPet"');
    expect(md).toContain("suite: PETSTORE-API");
    expect(md).toContain("technique: equivalence-partitioning");
    expect(md).toContain("execution: auto");
    expect(md).toContain("status: ✅ Passed");
    expect(md).toContain("## Methodology");
    expect(md).toContain("- Technique: equivalence-partitioning");
    expect(md).toContain("- Rationale: Happy-path case in the valid equivalence class for POST /pets: asserts 201.");
    expect(md).toContain("## Request");
    expect(md).toContain("- POST /pets");
    expect(md).toContain('"body":{"name":"string"}');
    expect(md).toContain("## Expected Result");
    expect(md).toContain("- HTTP 201 conforming to the declared success schema");
  });

  it("omits the schema-conformance note when no success schema is declared", () => {
    const md = renderApiTestCaseMd({ ...apiCase, expectedSchema: undefined }, apiDoc);
    expect(md).toContain("- HTTP 201");
    expect(md).not.toContain("conforming to");
  });
});

describe("parseApiTestCaseMd (API-7, #144: ATC .md → codegen input)", () => {
  it("round-trips from the renderer (id/title/method/path/body/expectedStatus)", () => {
    const parsed = parseApiTestCaseMd(renderApiTestCaseMd(apiCase, apiDoc));
    expect(parsed.id).toBe("ATC-PETSTORE-API-001");
    expect(parsed.title).toBe("createPet");
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/pets");
    expect(parsed.body).toEqual({ name: "string" });
    expect(parsed.expectedStatus).toBe("201");
    expect(parsed.params).toEqual({ path: {}, query: {}, header: {}, cookie: {} });
  });

  it("recovers non-body params (path/query/header/cookie) grouped by location", () => {
    const withParams: ApiCase = {
      ...apiCase,
      body: undefined,
      params: { path: { id: "1" }, query: { limit: "10" }, header: {}, cookie: {} },
    };
    const parsed = parseApiTestCaseMd(renderApiTestCaseMd(withParams, apiDoc));
    expect(parsed.params).toEqual({ path: { id: "1" }, query: { limit: "10" }, header: {}, cookie: {} });
    expect(parsed.body).toBeUndefined();
  });

  it("no params/body sent (bare GET) → empty params, no body", () => {
    const bare: ApiCase = { ...apiCase, method: "GET", path: "/pets", body: undefined };
    const parsed = parseApiTestCaseMd(renderApiTestCaseMd(bare, apiDoc));
    expect(parsed.params).toEqual({ path: {}, query: {}, header: {}, cookie: {} });
    expect(parsed.body).toBeUndefined();
  });

  it("'default' expected status (no HTTP-status line matched) falls back to 'default'", () => {
    // Defensive default — every rendered doc actually has a "HTTP <status>" line (this covers a
    // malformed/hand-edited doc without one).
    const parsed = parseApiTestCaseMd("---\nid: X\ntitle: \"x\"\n---\n\n## Request\n- GET /x\n");
    expect(parsed.expectedStatus).toBe("default");
  });
});
