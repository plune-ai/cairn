import { describe, it, expect } from "vitest";
import { generateSuite, automateCases } from "../../src/codegen/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { TestCase } from "../../src/design/index.js";
import type { ParsedTestCase } from "../../src/artifacts/testcase-md.js";

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
