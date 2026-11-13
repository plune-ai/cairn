import { describe, it, expect } from "vitest";
import { generateSuite, automateCases, automateApiCases } from "../../src/codegen/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { TestCase } from "../../src/design/index.js";
import type { ParsedTestCase, ParsedApiCase } from "../../src/artifacts/testcase-md.js";

const study: PageStudy = {
  url: "http://x/login",
  screenshotB64: "",
  ariaYaml: "",
  capturedBy: "lib",
  elements: [{ ref: "e6", role: "button", name: "Sign In", interactive: true, rank: 3 }],
};
const testCases: TestCase[] = [
  {
    id: "tc-1",
    title: "Логін",
    technique: "exploratory",
    preconditions: [],
    steps: ["Натиснути Sign In"],
    expected: "OK",
    priority: "high",
    elementRefs: ["e6"],
  },
];

describe("generateSuite", () => {
  it("→ GeneratedSuite; prompt contains the test cases and baseUrl", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({
        files: [
          {
            path: "login.spec.ts",
            content:
              "import { test, expect } from '@playwright/test';\ntest('логін', async ({ page }) => { await page.goto('http://x/login'); });",
          },
        ],
      });
    };
    const suite = await generateSuite(
      { study, pageSemantics: "Форма логіну", testCases },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
    );
    expect(suite.files).toHaveLength(1);
    expect(suite.files[0]?.path).toBe("login.spec.ts");
    expect(suite.files[0]?.content).toContain("@playwright/test");
    expect(captured).toContain("http://x/login");
    expect(captured).toContain("Логін");
  });

  it("sanitizes paths (no traversal/absolute)", async () => {
    const fakeInvoke: StructuredInvoke = async (schema) =>
      schema.parse({
        files: [
          { path: "../../evil.ts", content: "x" },
          { path: "/abs.spec.ts", content: "y" },
        ],
      });
    const suite = await generateSuite(
      { study, pageSemantics: "x", testCases },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
    );
    expect(suite.files[0]?.path).not.toContain("..");
    expect(suite.files[1]?.path.startsWith("/")).toBe(false);
  });
});

describe("automateCases (decoupled automate — repair support, #40)", () => {
  const cases: ParsedTestCase[] = [
    {
      id: "ATC-1",
      execution: "auto",
      title: "Login works",
      steps: ["Click Sign In"],
      expected: ["Logged in"],
      selectors: [{ label: "Sign In", locator: "page.getByRole('button', { name: 'Sign In' })" }],
    },
  ];

  it("adds a REPAIR instruction carrying the failing tests when a repairHint is given", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ files: [{ path: "a.spec.ts", content: "import { test } from '@playwright/test';" }] });
    };
    await automateCases(
      cases,
      { baseUrl: "http://x", pageSemantics: "p" },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
      "Login works",
    );
    expect(captured).toContain("REPAIR");
    expect(captured).toContain("Login works");
  });

  it("omits the REPAIR instruction on the initial pass (no hint)", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ files: [{ path: "a.spec.ts", content: "x" }] });
    };
    await automateCases(
      cases,
      { baseUrl: "http://x", pageSemantics: "p" },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
    );
    expect(captured).not.toContain("REPAIR");
  });
});

describe("automateApiCases (API-7, #144 — no LLM, request fixture)", () => {
  const getCase: ParsedApiCase = {
    id: "ATC-PETSTORE-API-001",
    title: "getPet",
    method: "GET",
    path: "/pets/{id}",
    params: { path: { id: "1" }, query: { verbose: "true" }, header: {}, cookie: {} },
    expectedStatus: "200",
  };
  const postCase: ParsedApiCase = {
    id: "ATC-PETSTORE-API-002",
    title: "createPet",
    method: "POST",
    path: "/pets",
    params: { path: {}, query: {}, header: {}, cookie: {} },
    body: { name: "Fido" },
    expectedStatus: "201",
  };

  it("generates one api.spec.ts file, no LLM invoke involved", () => {
    const suite = automateApiCases([getCase], { baseUrl: "https://api.test" });
    expect(suite.files).toHaveLength(1);
    expect(suite.files[0]?.path).toBe("api.spec.ts");
    expect(suite.files[0]?.content).toContain("@playwright/test");
  });

  it("substitutes path params and appends the query string", () => {
    const suite = automateApiCases([getCase], { baseUrl: "https://api.test" });
    const content = suite.files[0]?.content ?? "";
    expect(content).toContain("${baseURL}/pets/1?verbose=true");
    expect(content).toContain('method: "GET"');
  });

  it("embeds the request body and a JSON content-type header", () => {
    const suite = automateApiCases([postCase], { baseUrl: "https://api.test" });
    const content = suite.files[0]?.content ?? "";
    expect(content).toContain('data: {"name":"Fido"}');
    expect(content).toContain('"Content-Type":"application/json"');
    expect(content).toContain('method: "POST"');
  });

  it("asserts an exact status code", () => {
    const content = automateApiCases([postCase], { baseUrl: "https://api.test" }).files[0]?.content ?? "";
    expect(content).toContain("expect(response.status()).toBe(201);");
  });

  it("asserts a non-error status for 'default'", () => {
    const c: ParsedApiCase = { ...getCase, expectedStatus: "default" };
    const content = automateApiCases([c], { baseUrl: "https://api.test" }).files[0]?.content ?? "";
    expect(content).toContain("toBeLessThan(400)");
  });

  it("asserts a status class range for e.g. '2XX'", () => {
    const c: ParsedApiCase = { ...getCase, expectedStatus: "2XX" };
    const content = automateApiCases([c], { baseUrl: "https://api.test" }).files[0]?.content ?? "";
    expect(content).toContain("toBeGreaterThanOrEqual(200)");
    expect(content).toContain("toBeLessThan(300)");
  });

  it("baseURL falls back to the recorded value but is overridable via API_BASE_URL", () => {
    const content = automateApiCases([getCase], { baseUrl: "https://api.test" }).files[0]?.content ?? "";
    expect(content).toContain('process.env.API_BASE_URL ?? "https://api.test"');
  });

  it("strips a trailing slash from baseURL so it never doubles with the path's leading slash", () => {
    const content = automateApiCases([getCase], { baseUrl: "https://api.test/" }).files[0]?.content ?? "";
    expect(content).toContain('.replace(/\\/+$/, "")');
  });
});

describe("the generator, not the model, writes each case's stableId onto its test", () => {
  const annotated = (id: string): string => `{ annotation: { type: "stableId", description: ${JSON.stringify(id)} } }`;
  const reply = (files: { path: string; content: string; cases: { test: string; caseId: string }[] }[]): StructuredInvoke =>
    async (schema) => schema.parse({ files });

  it("generateSuite: the test the model maps to a case carries that case's stableId, whatever its title", async () => {
    const cases: TestCase[] = [
      { ...testCases[0]!, id: "tc-1", stableId: "c-111" },
      { ...testCases[0]!, id: "tc-2", stableId: "c-222" },
    ];
    const content = [
      "import { test, expect } from '@playwright/test';",
      "test('user can\\'t sign in blank', async ({ page }) => {});",
      'test("shows the button", async ({ page }) => {});',
      "test('an extra check', async ({ page }) => {});",
    ].join("\n");
    const suite = await generateSuite(
      { study, pageSemantics: "x", testCases: cases },
      {
        invoke: reply([
          {
            path: "static-checks.spec.ts",
            content,
            cases: [
              { test: "user can't sign in blank", caseId: "tc-2" },
              { test: "shows the button", caseId: "tc-1" },
              { test: "a test that is not in the file", caseId: "tc-1" },
              { test: "an extra check", caseId: "tc-9" }, // no such case
            ],
          },
        ]),
        prompts: new PromptRegistry(),
      },
    );
    const out = suite.files[0]!.content;
    expect(out).toContain(`test('user can\\'t sign in blank', ${annotated("c-222")}, async`);
    expect(out).toContain(`test("shows the button", ${annotated("c-111")}, async`);
    expect(out).toContain("test('an extra check', async"); // unknown case id: left as written
    expect(suite.files[0]).not.toHaveProperty("cases");
  });

  it("automateCases: TC-n maps to the parsed case's stableId; same title in two files keeps distinct ids", async () => {
    const parsed = (stableId: string): ParsedTestCase => ({
      id: "ATC-1",
      stableId,
      execution: "auto",
      title: "Submit",
      steps: ["Click Submit"],
      expected: ["Sent"],
      selectors: [],
    });
    const body = "import { test } from '@playwright/test';\ntest('submits the form', async ({ page }) => {});";
    const suite = await automateCases(
      [parsed("c-aaa"), parsed("c-bbb")],
      { baseUrl: "http://x", pageSemantics: "p" },
      {
        invoke: reply([
          { path: "a.spec.ts", content: body, cases: [{ test: "submits the form", caseId: "TC-1" }] },
          { path: "b.spec.ts", content: body, cases: [{ test: "submits the form", caseId: "TC-2" }] },
        ]),
        prompts: new PromptRegistry(),
      },
    );
    expect(suite.files[0]!.content).toContain(annotated("c-aaa"));
    expect(suite.files[1]!.content).toContain(annotated("c-bbb"));
  });

  it("a test that already has a details object, or a case without a stableId, is left as written", async () => {
    const content = "import { test } from '@playwright/test';\ntest('tagged', { tag: '@smoke' }, async () => {});\ntest('old', async () => {});";
    const suite = await automateCases(
      [
        { id: "ATC-1", stableId: "c-1", execution: "auto", title: "a", steps: [], expected: [], selectors: [] },
        { id: "ATC-2", stableId: "", execution: "auto", title: "b", steps: [], expected: [], selectors: [] },
      ],
      { baseUrl: "http://x", pageSemantics: "p" },
      {
        invoke: reply([{ path: "a.spec.ts", content, cases: [{ test: "tagged", caseId: "TC-1" }, { test: "old", caseId: "TC-2" }] }]),
        prompts: new PromptRegistry(),
      },
    );
    expect(suite.files[0]!.content).toBe(content);
  });
});
