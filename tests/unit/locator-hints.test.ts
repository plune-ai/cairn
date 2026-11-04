import { describe, it, expect } from "vitest";
import { generateSuite } from "../../src/codegen/index.js";
import { designTestCases } from "../../src/design/index.js";
import { buildInteractionMap } from "../../src/documentarian/index.js";
import { QA_PLAYWRIGHT_TS_WRITER } from "../../src/prompts/local/qa-playwright-ts-writer.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import { scopedLocator } from "../../src/observe/overlays.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { VerifiedElement } from "../../src/browser/types.js";

const study: PageStudy = { url: "http://x/people", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] };

const row = (n: string): { role: string; name: string } => ({ role: "row", name: `${n} Delete` });
const narrowed = (ref: string, who: string): VerifiedElement => ({
  ref, role: "button", name: "Delete", interactive: true, rank: 3, count: 3, verified: true, narrowedBy: row(who),
  context: [row(who)],
});
const ambiguous: VerifiedElement = { ref: "e9", role: "button", name: "Archive", interactive: true, rank: 3, count: 2, verified: false, ambiguous: true };
const plain: VerifiedElement = { ref: "e8", role: "link", name: "Docs", interactive: true, rank: 3, count: 4, verified: false };

const capture = (): { invoke: StructuredInvoke; seen: () => string } => {
  let text = "";
  return {
    invoke: (async (schema: { parse(v: unknown): unknown }, messages: unknown) => {
      text = JSON.stringify(messages);
      return schema.parse({ testCases: [], files: [{ path: "a.spec.ts", content: "// x" }] });
    }) as unknown as StructuredInvoke,
    seen: () => text,
  };
};
const elements = [narrowed("e1", "John Doe"), narrowed("e2", "Jane Roe"), ambiguous, plain];

describe("no blind .first() is asked for (#226)", () => {
  it("the writer prompt says narrow by context; .first() / .nth() only with a comment saying why the position is the point", () => {
    expect(QA_PLAYWRIGHT_TS_WRITER).not.toMatch(/ALWAYS use \.first\(\)/);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/narrow by context/i);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/only with a comment/i);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/sorting/);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/getByRole\('row', \{ name:/);
  });

  it("codegen: a repeated element that a row narrows gets that row's locator; none says .first()", async () => {
    const c = capture();
    await generateSuite({ study, pageSemantics: "People", testCases: [], elements }, { invoke: c.invoke, prompts: new PromptRegistry() });
    const p = c.seen();
    expect(p).toContain(scopedLocator(undefined, "button", "Delete", row("Jane Roe")).replace(/\\/g, "\\\\"));
    expect(p).not.toMatch(/repeated, \.first\(\)/);
    expect(p).toContain("ambiguous");
    expect(p).toContain("do not click it");
    // a repeated element with no narrowing known: told to narrow by context, not to take the first
    expect(p).toMatch(/Docs.*×4 — repeated; narrow by the accessible name of its row, card or section/);
  });

  it("design: the same hints", async () => {
    const c = capture();
    await designTestCases({ study, pageSemantics: "People", elements }, { invoke: c.invoke, prompts: new PromptRegistry() });
    const p = c.seen();
    expect(p).toContain("Jane Roe Delete");
    expect(p).not.toMatch(/repeated, \.first\(\)/);
    expect(p).toContain("ambiguous");
  });

  it("the interaction map keeps no blind .first() in a locator; a narrowed element's locator goes through its row", () => {
    const map = buildInteractionMap(study, { pageSemantics: "p", primaryRefs: [], viewSwitchers: [] }, elements, [], "fp");
    for (const e of map.elements) expect(e.locator, e.ref).not.toMatch(/\.first\(\)|\.nth\(/);
    expect(map.elements.find((e) => e.ref === "e2")!.locator).toContain("getByRole('row', { name: 'Jane Roe Delete', exact: true })");
  });
});
