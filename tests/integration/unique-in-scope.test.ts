import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import type { ElementRef } from "../../src/browser/types.js";
import { runExploreGraph, type ExploreDeps } from "../../src/agent/graph.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import { renderReportMd } from "../../src/artifacts/report.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import { buildInteractionMap } from "../../src/documentarian/index.js";
import { generateSuite } from "../../src/codegen/index.js";
import { designTestCases } from "../../src/design/index.js";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** #226: click only what is visible and unique in its scope; narrow by the name of the row; never click blindly. */
describe("visible and unique in its scope (integration, real Chromium)", () => {
  let server: FixtureServer;
  let backend: PlaywrightLibBackend;

  beforeAll(async () => {
    server = await startFixtureServer();
    backend = new PlaywrightLibBackend({ headless: true });
  });
  afterAll(async () => {
    await backend.close();
    await server.close();
  });

  async function open(path: string): Promise<{ els: ElementRef[]; aria: string }> {
    const obs = await backend.observe({ url: `${server.url}${path}` });
    return { els: parseAriaSnapshot(obs.ariaSnapshot, { nonModal: new Set(obs.nonModal ?? []) }), aria: obs.ariaSnapshot };
  }
  const deletes = (els: ElementRef[]): ElementRef[] => els.filter((e) => e.role === "button" && e.name === "Delete" && e.context?.length);
  const now = async (): Promise<string> => (await backend.observe({})).ariaSnapshot;

  it("a table of three rows, each with «Delete»: the element of the second row clicks the second row", async () => {
    const { els } = await open("/table.html");
    const rows = deletes(els);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.context![0])).toEqual([
      { role: "row", name: "John Doe Delete" },
      { role: "row", name: "Jane Roe Delete" },
      { role: "row", name: "Max Poe Delete" },
    ]);
    const res = await backend.act({ kind: "click", ref: rows[1]!.ref });
    expect(res.ok).toBe(true);
    expect(await now()).toContain("Last delete: Jane Roe");
    await open("/table.html");
    expect((await backend.act({ kind: "click", ref: rows[2]!.ref })).ok).toBe(true);
    expect(await now()).toContain("Last delete: Max Poe");
  });

  it("verify counts the visible ones in scope, and says which row narrows each to one", async () => {
    const { els } = await open("/table.html");
    const v = await backend.verify!(deletes(els));
    expect(v.map((x) => [x.count, x.verified, x.ambiguous, x.narrowedBy?.name])).toEqual([
      [3, true, undefined, "John Doe Delete"],
      [3, true, undefined, "Jane Roe Delete"],
      [3, true, undefined, "Max Poe Delete"],
    ]);
  });

  it("two «Delete» buttons nothing tells apart: no click, the answer says ambiguous", async () => {
    const { els } = await open("/ambiguous.html");
    const both = els.filter((e) => e.role === "button" && e.name === "Delete");
    expect(both).toHaveLength(2);
    for (const b of both) {
      const res = await backend.act({ kind: "click", ref: b.ref });
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("ambiguous");
      expect(res.ambiguous).toMatchObject({ role: "button", name: "Delete", count: 2 });
    }
    expect(await now()).toContain("Clicked: nothing");
    const v = await backend.verify!(both);
    expect(v.map((x) => [x.count, x.verified, x.ambiguous])).toEqual([
      [2, false, true],
      [2, false, true],
    ]);
  });

  it("two «Delete» buttons hidden while they are looked for, back when the click comes: still no blind first one", async () => {
    const { els } = await open("/ambiguous.html");
    const del = els.find((e) => e.role === "button" && e.name === "Delete")!;
    const page = (backend as unknown as { page: { evaluate(script: string): Promise<unknown> } }).page;
    await page.evaluate(`{
      const both = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Delete");
      for (const b of both) b.style.display = "none";
      setTimeout(() => { for (const b of both) b.style.display = ""; }, 400);
    }`);
    const res = await backend.act({ kind: "click", ref: del.ref, watch: false });
    expect(res.ok).toBe(false);
    expect(await now()).toContain("Clicked: nothing");
  });

  it("two links with the same name that go to the same place are one destination: clicked, not ambiguous", async () => {
    const { els } = await open("/ambiguous.html");
    const more = els.find((e) => e.role === "link" && e.name === "More")!;
    const res = await backend.act({ kind: "click", ref: more.ref });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("navigated");
  });

  /** The whole exploration graph on a real page, with no LLM: only the prompts it would send are kept. */
  async function explore(path: string): Promise<{ out: Awaited<ReturnType<typeof runExploreGraph>>; prompts: string[] }> {
    const prompts: string[] = [];
    const spy = (value: unknown): StructuredInvoke =>
      (async (_schema: unknown, messages: unknown) => {
        prompts.push(JSON.stringify(messages));
        return value;
      }) as unknown as StructuredInvoke;
    const deps: ExploreDeps = {
      gateway: backend as unknown as BrowserGateway,
      prompts: new PromptRegistry(),
      analyzeInvoke: spy({ pageSemantics: "A page", primaryRefs: [], viewSwitchers: [] }),
      designInvoke: spy({ testCases: [] }),
      codegenInvoke: spy({ files: [{ path: "a.spec.ts", content: "// generated" }] }),
      useVision: false,
      runWriter: {
        runId: "t", dir: "/tmp/t", writeStudy: async () => undefined, writeSuite: async () => [], writeReport: async () => undefined,
        writeScreenshot: async () => undefined, writeAria: async () => undefined, writeReportMd: async () => undefined,
        writeLog: async () => undefined, writeTestCases: async () => [], writeOverlays: async () => undefined,
      } as unknown as ExploreDeps["runWriter"],
      validate: async () => ({ results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 }),
      maxRepair: 0,
    };
    const out = await runExploreGraph(deps, { url: `${server.url}${path}`, runId: "t" });
    return { out, prompts };
  }

  it("exploration of the table: every Delete is verified through its row; code is asked for through the row, not .first()", async () => {
    const { out, prompts } = await explore("/table.html");
    const del = out.verified.filter((v) => v.role === "button" && v.name === "Delete");
    expect(del.map((v) => v.narrowedBy?.name)).toEqual(["John Doe Delete", "Jane Roe Delete", "Max Poe Delete"]);
    expect(out.ambiguous).toEqual([]);
    const codegen = prompts.find((p) => p.includes("Rules (STRICT)"))!;
    expect(codegen).toContain("getByRole('row', { name: 'Jane Roe Delete', exact: true }).getByRole('button', { name: 'Delete', exact: true })");
    expect(codegen).not.toMatch(/repeated, \.first\(\)/);
    expect(await now()).toContain("Last delete: none"); // nothing was deleted on the way
  });

  it("exploration of two indistinguishable «Delete» buttons: no click, ambiguous in the run report", async () => {
    const { out, prompts } = await explore("/ambiguous.html");
    expect(out.ambiguous).toEqual([{ page: `${server.url}/ambiguous.html`, role: "button", name: "Delete", count: 2 }]);
    expect(await now()).toContain("Clicked: nothing");
    expect(out.verified.filter((v) => v.name === "Delete").map((v) => v.ambiguous)).toEqual([true, true]);
    const md = renderReportMd({ runId: "t", url: out.study.url, backend: "lib", profile: "p", pageSemantics: "s", elements: out.study.elements, testCases: [], ambiguous: out.ambiguous });
    expect(md).toContain("## Ambiguous elements (1)");
    expect(md).toContain('button "Delete"');
    expect(prompts.find((p) => p.includes("Rules (STRICT)"))!).toContain("do not click it");
  });

  it("on every fixture page no blind .first() / .nth( reaches a locator or is asked of the generator", async () => {
    const site = fileURLToPath(new URL("../fixtures/site", import.meta.url));
    const pages = readdirSync(site).filter((f) => f.endsWith(".html"));
    expect(pages.length).toBeGreaterThan(10);
    let repeated = 0;
    for (const page of pages) {
      const { els, aria } = await open(`/${page}`);
      const verified = (await backend.verify!(els.filter((e) => e.interactive))).filter((v) => v.count >= 1);
      repeated += verified.filter((v) => v.count > 1).length;
      const study = { url: `${server.url}/${page}`, screenshotB64: "", ariaYaml: aria, elements: els, capturedBy: "lib" as const };
      const map = buildInteractionMap(study, { pageSemantics: "p", primaryRefs: [], viewSwitchers: [] }, verified, [], "fp");
      expect(map.elements.filter((e) => /\.(first\(\)|nth\()/.test(e.locator)), page).toEqual([]);
      const seen: string[] = [];
      const invoke = (async (schema: { parse(v: unknown): unknown }, messages: unknown) => {
        seen.push(JSON.stringify(messages));
        return schema.parse({ testCases: [], files: [{ path: "a.spec.ts", content: "//" }] });
      }) as unknown as StructuredInvoke;
      const prompts = new PromptRegistry();
      await generateSuite({ study, pageSemantics: "p", testCases: [], elements: verified }, { invoke, prompts });
      await designTestCases({ study, pageSemantics: "p", elements: verified }, { invoke, prompts });
      for (const p of seen) expect(p, page).not.toMatch(/repeated, \.first\(\)|ALWAYS use \.first\(\)/);
    }
    expect(repeated).toBeGreaterThan(0); // the table and the ambiguous page do have repeated elements
  }, 120_000);
});
