import { describe, it, expect } from "vitest";
import { generateSuite } from "../../src/codegen/index.js";
import { lintErrors, knownFromOverlays, type KnownElement } from "../../src/codegen/lint.js";
import { failedTestsHint } from "../../src/agent/repair-loop.js";
import { makeTriage } from "../../src/decider/uses/repair-triage.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { VerifiedElement } from "../../src/browser/types.js";
import type { Answer, Decider } from "../../src/decider/types.js";

const el = (role: string, name: string, over: Partial<VerifiedElement> = {}): VerifiedElement => ({
  ref: `${role}-${name}`, role, name, interactive: true, rank: 1, count: 1, verified: true, ...over,
});
const study: PageStudy = { url: "http://x/", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] };

async function promptFor(elements: VerifiedElement[]): Promise<string> {
  let captured = "";
  const invoke: StructuredInvoke = async (schema, messages) => {
    captured = JSON.stringify(messages);
    return schema.parse({ files: [{ path: "a.spec.ts", content: "x" }] });
  };
  await generateSuite({ study, pageSemantics: "p", testCases: [], elements }, { invoke, prompts: new PromptRegistry() });
  return captured;
}
const suite = (content: string) => ({ files: [{ path: "a.spec.ts", content }] });

describe("codegen uses only locators that resolve to one visible element (#279)", () => {
  it("a name that is part of another element's name is told to be exact (Menu / Select Menu)", async () => {
    const p = await promptFor([el("link", "Menu"), el("link", "Select Menu")]);
    expect(p).toMatch(/link \\"Menu\\".*exact: true.*Select Menu/);
    expect(p).toMatch(/link \\"Select Menu\\".{4}Test cases/); // the longer name has no hint of its own
  });

  it("an element outside the viewport is marked as not clickable (skip link)", async () => {
    const p = await promptFor([el("link", "Skip to content", { offViewport: true })]);
    expect(p).toMatch(/Skip to content\\".*outside the viewport.*do not click/);
  });

  it("the lint refuses a bare locator that matches several elements (x and Close buttons)", () => {
    const known: KnownElement[] = [el("button", "Close", { count: 2, ambiguous: true })];
    const found = lintErrors(suite("await page.getByRole('button', { name: 'Close' }).click();"), known);
    expect(found.map((f) => f.kind)).toEqual(["ambiguous-locator"]);
    // reached through its dialog it is one element
    expect(lintErrors(suite("await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();"), known)).toEqual([]);
  });

  it("the lint refuses a non-exact name that is part of another name, and accepts exact: true", () => {
    const known: KnownElement[] = [el("link", "Menu"), el("link", "Select Menu")];
    expect(lintErrors(suite("await page.getByRole('link', { name: 'Menu' }).click();"), known).map((f) => f.kind)).toEqual(["ambiguous-locator"]);
    expect(lintErrors(suite("await page.getByRole('link', { name: 'Menu', exact: true }).click();"), known)).toEqual([]);
  });

  it("the lint refuses a locator for an element outside the viewport", () => {
    const known: KnownElement[] = [el("link", "Skip", { offViewport: true })];
    expect(lintErrors(suite("await page.getByRole('link', { name: 'Skip', exact: true }).click();"), known).map((f) => f.kind)).toEqual(["ambiguous-locator"]);
  });
});

describe("lint judges only calls on page (#279)", () => {
  const known: KnownElement[] = [el("button", "Close", { count: 2, ambiguous: true }), el("paragraph", "Close"), el("link", "Menu"), el("link", "Select Menu")];
  const kinds = (code: string): string[] => lintErrors(suite(code), known).map((f) => f.kind);

  it("a link that is not on the page (the snapshot has only paragraph: Close) is a finding", () => {
    expect(kinds("await page.getByRole('link', { name: 'Close' }).click();")).toEqual(["ambiguous-locator"]);
    expect(kinds("await page.getByRole('link', { name: 'Menu', exact: true }).click();")).toEqual([]);
  });
  it("skips a call scoped through a locator held in a variable", () => {
    expect(kinds(`const dialog = page.getByRole('dialog');
await dialog.getByRole('button', { name: 'Close' }).click();`)).toEqual([]);
  });
  it("skips a call scoped through .locator(...)", () => {
    expect(kinds("await page.locator('#box').getByRole('button', { name: 'Close' }).click();")).toEqual([]);
  });
  it("skips a chain split over lines, and still judges a page call split over lines", () => {
    expect(kinds(`await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Close' })
  .click();`)).toEqual([]);
    expect(kinds(`await page
  .getByRole('button', { name: 'Close' })
  .click();`)).toEqual(["ambiguous-locator"]);
  });
  it("does not read a comment", () => {
    expect(kinds("// page.getByRole('link', { name: 'Close' })")).toEqual([]);
  });
});

describe("lint knows what the overlays hold (#279)", () => {
  const btn = (name: string, locator = `page.getByRole('button', { name: '${name}', exact: true })`) => ({ role: "button", name, locator });
  const page = [el("button", "Open")];

  it("a button that exists only in an overlay, written as an unscoped page locator, raises nothing", () => {
    const known = [...page, ...knownFromOverlays([{ elements: [btn("Close")] }])];
    expect(lintErrors(suite("await page.getByRole('button', { name: 'Close', exact: true }).click();"), known)).toEqual([]);
  });
  it("the same name in two separate views is not a clash", () => {
    const known = [...page, ...knownFromOverlays([{ elements: [btn("Close")] }, { elements: [btn("Close")] }])];
    expect(lintErrors(suite("await page.getByRole('button', { name: 'Close', exact: true }).click();"), known)).toEqual([]);
  });
  it("two Close elements in one overlay are still ambiguous", () => {
    const known = [...page, ...knownFromOverlays([{ elements: [btn("Close"), btn("Close")] }])];
    expect(lintErrors(suite("await page.getByRole('button', { name: 'Close', exact: true }).click();"), known).map((f) => f.kind)).toEqual(["ambiguous-locator"]);
  });
});

describe("repair treats a strict-mode violation or an off-viewport target as a locator error (#279)", () => {
  const strict = "Error: strict mode violation: getByRole('button', { name: 'Close' }) resolved to 2 elements";
  const offscreen = "Error: locator.click: Timeout 30000ms exceeded.\n  - element is outside of the viewport";
  const results = [
    { test: "a", status: "failed" as const, error: strict },
    { test: "b", status: "failed" as const, error: offscreen },
  ];

  it("the hint names both as locator errors to fix", () => {
    const hint = failedTestsHint(results);
    expect(hint).toMatch(/- a.*locator error.*several elements/s);
    expect(hint).toMatch(/- b.*locator error.*outside the viewport/s);
  });

  it("triage never leaves them out of repair, whatever the decider says", async () => {
    const answer: Answer = { type: "choice", value: "app-bug", dist: { "app-bug": 1 }, confidence: 0.99 };
    const decider = {
      provider: "laya", model: "m", caps: { maxInputChars: 1200, maxQuestionChars: 400, maxOptions: 20, maxQuestionsPerCall: 16 },
      uses: new Set(["repair-triage"]), minConfidence: 0.75, scrub: (t: string) => t,
      summary: () => ({ provider: "laya", model: "m", calls: 0, fallbacks: [] }),
      decide: async (_u: string, _s: string, qs: Record<string, unknown>) => Object.fromEntries(Object.keys(qs).map((k) => [k, answer])),
    } as unknown as Decider;
    const out = await makeTriage(decider)(results);
    expect(out.map((t) => [t.test, t.exclude])).toEqual([["a", false], ["b", false]]);
    expect(out.map((t) => t.category)).toEqual(["locator-ambiguous", "locator-missing"]);
  });
});
