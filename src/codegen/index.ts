import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { PageStudy } from "../observe/index.js";
import type { TestCase } from "../design/index.js";
import type { VerifiedElement } from "../browser/types.js";
import { formatTransitions, type Transition } from "../probe/index.js";
import { repeatedHint, uniquenessHint } from "../observe/locator-hints.js";
import { detectLanguage } from "../checklist/index.js";
import type { ParsedTestCase, ParsedApiCase } from "../artifacts/testcase-md.js";
import { GeneratedSuiteSchema, type GeneratedSuite } from "./schema.js";
import { FLOW_FIXTURE_FILE } from "../api/flows.js";

export type { GeneratedSuite, FileBlob } from "./schema.js";
export { GeneratedSuiteSchema, FileBlobSchema } from "./schema.js";
export { MAILBOX_FIXTURE_FILE, mailboxPromptSection, renderMailboxSteps, withMailboxFixture } from "./mailbox.js";

export interface CodegenInput {
  study: PageStudy;
  pageSemantics: string;
  testCases: TestCase[];
  /** Repair context: which tests failed (repair node). */
  repairHint?: string;
  /** Discovered elements (count≥1) from verify; fallback — study.elements. */
  elements?: VerifiedElement[];
  /** Observed state transitions (act→observe, Stage B). */
  transitions?: Transition[];
  /** #225: the overlays found by exploration ({@link formatOverlays}); "" → none. */
  overlays?: string;
  /** ADR-0023 §4: the mailbox/TOTP section ({@link mailboxPromptSection}) when a page needs it and the steps are on. */
  mailbox?: string;
}

/** #225: heads the overlay block of the codegen prompt. */
const OVERLAYS_HEADER = `Overlays found on the page. Each one is its OWN component object in the page-object model (a class such as \`NewProjectDialog\` with the dialog as its root, not methods spread over the page class); a test opens it through the trigger, then works only through that object. Every locator inside it is scoped to its root, e.g. \`page.getByRole('dialog', { name: 'New project', exact: true }).getByRole('button', { name: 'Save', exact: true })\`, so a same-named element on the page is never confused with it. While a modal overlay is open, do not touch the page under it; close it first (Escape or its Cancel / close button).`;

export interface CodegenDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
}

/** Safe relative path inside runs/<id>/tests (no traversal/absolute paths). */
function sanitizePath(p: string): string {
  const cleaned = p
    .replace(/\\/g, "/")
    .replace(/\.\.+/g, "")
    .replace(/^\/+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "test.spec.ts";
}

/** Generate a runnable `@playwright/test` suite from test cases (ADR-0005). */
export async function generateSuite(input: CodegenInput, deps: CodegenDeps): Promise<GeneratedSuite> {
  const els: VerifiedElement[] =
    input.elements ?? input.study.elements.map((e) => ({ ...e, count: 1, verified: true }));
  const elements = els
    .filter((e) => e.interactive)
    .map(
      (e) =>
        `${e.ref} · ${e.role}${e.name ? ` "${e.name}"` : ""}${repeatedHint(e)}${uniquenessHint(e, els)}${e.scope ? ` [inside ${e.scope.role}${e.scope.name ? ` "${e.scope.name}"` : ""}: locate it through that ${e.scope.role}]` : ""}${e.viaSwitcher ? ` [first click tab "${e.viaSwitcher.name ?? ""}"]` : ""}`,
    )
    .join("\n");
  const testCases = input.testCases
    .map(
      (tc) =>
        `${tc.id} [${tc.kind}/${tc.priority}/${tc.technique}] ${tc.title}: ${tc.steps.join("; ")} ⇒ ${tc.expected} (refs: ${tc.elementRefs.join(", ")})`,
    )
    .join("\n");

  const prompt = await deps.prompts.getPrompt("qa-playwright-ts-writer", {
    baseUrl: input.study.url,
    pageSemantics: input.pageSemantics,
    elements,
    testCases,
    transitions: formatTransitions(input.transitions ?? []),
    overlays: input.overlays ? `${OVERLAYS_HEADER}\n${input.overlays}` : "",
  });

  const base = input.mailbox ? `${prompt.text}\n\n${input.mailbox}` : prompt.text;
  const text = input.repairHint
    ? `${base}\n\nREPAIR: the previous generation failed the tests: ${input.repairHint}\nFix the locators/navigation/assertions so the tests pass.`
    : base;
  const suite = await deps.invoke(GeneratedSuiteSchema, [new HumanMessage(text)]);
  return { files: suite.files.map((f) => ({ path: sanitizePath(f.path), content: f.content })) };
}

/**
 * `automate` command: generate @playwright/test from PARSED test cases (.md).
 * Locators are taken directly from the cases (Selectors section) — those are what we use in the code.
 */
export async function automateCases(
  cases: ParsedTestCase[],
  /** #230: `apiFlows` — the available API flows (`formatFlowsForPrompt`); absent → the prompt is unchanged. */
  ctx: { baseUrl: string; pageSemantics: string; apiFlows?: string; mailbox?: string },
  deps: CodegenDeps,
  /** Repair context: failing test names from the previous attempt (#40 — automate now repairs). */
  repairHint?: string,
): Promise<GeneratedSuite> {
  const seen = new Map<string, string>();
  for (const c of cases) for (const s of c.selectors) if (!seen.has(s.locator)) seen.set(s.locator, s.label);
  const elements = [...seen.entries()].map(([locator, label]) => `${label}: ${locator}`).join("\n");
  const testCases = cases
    .map(
      (c, i) =>
        `TC-${i + 1}: ${c.title}\n` +
        // #230: the preconditions say which API flow a case uses — sent only when flows are available.
        (ctx.apiFlows && c.preconditions?.length ? `  Preconditions: ${c.preconditions.join("; ")}\n` : "") +
        `  Steps: ${c.steps.join("; ")}\n  Expected: ${c.expected.join("; ")}`,
    )
    .join("\n\n");

  const prompt = await deps.prompts.getPrompt("qa-playwright-ts-writer", {
    baseUrl: ctx.baseUrl,
    pageSemantics: ctx.pageSemantics,
    elements,
    testCases,
    transitions: "(from the case steps)",
    language: detectLanguage(testCases),
  });
  const flowsSection = ctx.apiFlows
    ? (
        await deps.prompts.getPrompt("qa-api-flows-codegen", {
          flows: ctx.apiFlows,
          fixtureFile: FLOW_FIXTURE_FILE,
          fixtureModule: FLOW_FIXTURE_FILE.replace(/\.ts$/, ""),
          baseUrl: ctx.baseUrl,
        })
      ).text
    : "";
  const base = [prompt.text, flowsSection, ctx.mailbox ?? ""].filter(Boolean).join("\n\n");
  const text = repairHint
    ? `${base}\n\nREPAIR: the previous generation failed the tests: ${repairHint}\nFix the locators/navigation/assertions so the tests pass.`
    : base;
  const suite = await deps.invoke(GeneratedSuiteSchema, [new HumanMessage(text)]);
  return { files: suite.files.map((f) => ({ path: sanitizePath(f.path), content: f.content })) };
}

/** Substitute `{name}` path params with their synthesised value (mirrors `api/runner.ts`'s buildUrl). */
function substitutePathParams(path: string, params: Record<string, unknown>): string {
  let out = path;
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(String(v)));
  return out;
}

/** Literal query string from synthesised query params (values are known at generation time). */
function buildQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Header params + a Cookie header from cookie params (mirrors `api/runner.ts`'s buildHeaders). */
function buildApiHeaders(c: ParsedApiCase): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.params.header)) headers[k] = String(v);
  const cookies = Object.entries(c.params.cookie);
  if (cookies.length) headers["Cookie"] = cookies.map(([k, v]) => `${k}=${v}`).join("; ");
  if (c.body !== undefined) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * A `response.status()` assertion for the case's declared success status — same vocabulary as
 * `api/runner.ts`'s `statusMatches`: an exact code, `default` (any non-error status), or an `NXX` range.
 */
function statusAssertion(expected: string): string {
  if (expected === "default") return "expect(response.status(), 'expected a non-error (< 400) status').toBeLessThan(400);";
  const range = /^(\d)XX$/i.exec(expected);
  if (range) {
    const base = Number(range[1]) * 100;
    return `expect(response.status()).toBeGreaterThanOrEqual(${base});\n  expect(response.status()).toBeLessThan(${base + 100});`;
  }
  return `expect(response.status()).toBe(${Number(expected)});`;
}

function renderApiTest(c: ParsedApiCase): string {
  const path = substitutePathParams(c.path, c.params.path);
  const query = buildQueryString(c.params.query);
  const headers = buildApiHeaders(c);
  const dataLine = c.body !== undefined ? `\n    data: ${JSON.stringify(c.body)},` : "";
  return `test(${JSON.stringify(c.title)}, async ({ request }) => {
  const response = await request.fetch(\`\${baseURL}${path}${query}\`, {
    method: ${JSON.stringify(c.method)},
    headers: ${JSON.stringify(headers)},${dataLine}
  });
  ${statusAssertion(c.expectedStatus)}
});`;
}

/**
 * `automate` command for API runs (API-7, #144): generate a runnable `@playwright/test` suite
 * straight from PARSED ATC cases — no LLM. Unlike the web flow, every field a request needs
 * (method/path/params/body/expected status) is already fully structured in the case, so codegen here
 * is deterministic templating (the same "no LLM" reasoning as API-2's case generation), using the
 * `request` fixture so the suite runs standalone in CI with no browser. `baseURL` is overridable via
 * `API_BASE_URL` so the same generated suite targets a different environment than the one it was
 * recorded against.
 */
export function automateApiCases(cases: ParsedApiCase[], ctx: { baseUrl: string }): GeneratedSuite {
  const tests = cases.map(renderApiTest).join("\n\n");
  const content = `import { test, expect } from '@playwright/test';

// Trailing slash stripped (mirrors api/runner.ts's buildUrl) — a trailing-slash override never
// doubles up with the case path, which always starts with "/".
const baseURL = (process.env.API_BASE_URL ?? ${JSON.stringify(ctx.baseUrl)}).replace(/\\/+$/, "");

${tests}
`;
  return { files: [{ path: "api.spec.ts", content }] };
}
