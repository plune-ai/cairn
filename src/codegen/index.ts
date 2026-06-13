import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { PageStudy } from "../observe/index.js";
import type { TestCase } from "../design/index.js";
import type { VerifiedElement } from "../browser/types.js";
import { formatTransitions, type Transition } from "../probe/index.js";
import { detectLanguage } from "../checklist/index.js";
import type { ParsedTestCase } from "../artifacts/testcase-md.js";
import { GeneratedSuiteSchema, type GeneratedSuite } from "./schema.js";

export type { GeneratedSuite, FileBlob } from "./schema.js";
export { GeneratedSuiteSchema, FileBlobSchema } from "./schema.js";

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
}

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
        `${e.ref} · ${e.role}${e.name ? ` "${e.name}"` : ""}${e.count > 1 ? ` (×${e.count} — repeated, .first())` : ""}${e.viaSwitcher ? ` [first click tab "${e.viaSwitcher.name ?? ""}"]` : ""}`,
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
  });

  const text = input.repairHint
    ? `${prompt.text}\n\nREPAIR: the previous generation failed the tests: ${input.repairHint}\nFix the locators/navigation/assertions so the tests pass.`
    : prompt.text;
  const suite = await deps.invoke(GeneratedSuiteSchema, [new HumanMessage(text)]);
  return { files: suite.files.map((f) => ({ path: sanitizePath(f.path), content: f.content })) };
}

/**
 * `automate` command: generate @playwright/test from PARSED test cases (.md).
 * Locators are taken directly from the cases (Selectors section) — those are what we use in the code.
 */
export async function automateCases(
  cases: ParsedTestCase[],
  ctx: { baseUrl: string; pageSemantics: string },
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
        `TC-${i + 1}: ${c.title}\n  Steps: ${c.steps.join("; ")}\n  Expected: ${c.expected.join("; ")}`,
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
  const text = repairHint
    ? `${prompt.text}\n\nREPAIR: the previous generation failed the tests: ${repairHint}\nFix the locators/navigation/assertions so the tests pass.`
    : prompt.text;
  const suite = await deps.invoke(GeneratedSuiteSchema, [new HumanMessage(text)]);
  return { files: suite.files.map((f) => ({ path: sanitizePath(f.path), content: f.content })) };
}
