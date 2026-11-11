import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { loadConfig } from "../../src/config/index.js";
import { runCollectDocs } from "../../src/agent/collect-docs.js";
import { runCheckDocs } from "../../src/agent/check-docs.js";
import { MATCH_LINE } from "../../src/documentarian/check.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";

/**
 * #231: `cairn check-docs` on the #24 fixture app, in real Chromium. The docs are what `collect-docs` wrote for it;
 * then the same docs with three deliberate mismatches. No model and no network beyond localhost.
 */
const BASE = join(process.cwd(), "runs", ".itest-check-docs");

const noModel = (async () => ({ purpose: "", userMight: [], overlays: [], questions: [] })) as unknown as StructuredInvoke;

const spec = (paths: string[]) => ({
  openapi: "3.0.3",
  info: { title: "Fixture API", version: "1" },
  paths: Object.fromEntries(paths.map((p) => [p, { get: { responses: { "200": { description: "ok" } } } }])),
});

describe("cairn check-docs (integration, real Chromium)", () => {
  let server: FixtureServer;
  let docsFile: string;
  const start = (): string => `${server.url}/docs-app/index.html`;
  const browser = { backend: "lib" as const };

  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    server = await startFixtureServer();
    const collected = await runCollectDocs({
      url: start(),
      config: loadConfig({ ANTHROPIC_API_KEY: "test-key-not-used" }),
      out: join(BASE, "docs"),
      cacheDir: join(BASE, "cache"),
      describeInvoke: noModel,
    });
    docsFile = collected.docsFile;
    await writeFile(join(BASE, "spec-match.json"), JSON.stringify(spec(["/api/ok", "/api/projects/{projectId}"])), "utf8");
    await writeFile(join(BASE, "spec-short.json"), JSON.stringify(spec(["/api/projects/{projectId}"])), "utf8");
  }, 180_000);
  afterAll(async () => {
    await server.close();
    await rm(BASE, { recursive: true, force: true });
  });

  it("the docs collect-docs wrote match the UI: no mismatch, and the report says so", async () => {
    const r = await runCheckDocs({ docs: join(BASE, "docs"), url: start(), browser, spec: join(BASE, "spec-match.json"), out: join(BASE, "match") });
    expect(r.report.mismatches).toEqual([]);
    expect(r.report.api).toEqual({ notInSpec: [], notSeen: ["GET /api/projects/{}"] });
    expect(r.mismatches).toBe(0);
    const md = await readFile(r.reportFile, "utf8");
    expect(md).toContain(`**${MATCH_LINE}**`);
    expect(md).toContain("[../docs/docs.md](../docs/docs.md)");
    expect(server.writes).toEqual([]);
  }, 180_000);

  it("docs with three deliberate mismatches: all three found, nothing else; the API one too", async () => {
    const md = await readFile(docsFile, "utf8");
    const edited = md
      .replace('- Press "Export"\n', '- Press "Export"\n- Press "Archive"\n') // in the docs, not in the UI
      .replace('- "Email alerts" — checkbox\n', "") // in the UI, not in the docs
      .replace('- "Project name" — textbox, required', '- "Name" — textbox, required'); // the name differs
    expect(edited).not.toBe(md);
    const file = join(BASE, "edited.md");
    await writeFile(file, edited, "utf8");

    const r = await runCheckDocs({ docs: file, url: start(), browser, spec: join(BASE, "spec-short.json"), out: join(BASE, "mismatch") });
    expect(r.report.mismatches).toHaveLength(3);
    expect(r.report.mismatches).toContainEqual(expect.objectContaining({ kind: "missing-in-ui", section: 'Screen "Projects"', anchor: "screen-projects", what: 'button "Archive"' }));
    expect(r.report.mismatches).toContainEqual(expect.objectContaining({ kind: "missing-in-docs", section: 'Screen "Settings"', anchor: "screen-settings", what: 'field "Email alerts" (checkbox)' }));
    expect(r.report.mismatches).toContainEqual(expect.objectContaining({ kind: "differs", section: 'Dialog "New project"', docs: "Name", ui: "Project name" }));
    expect(r.report.api?.notInSpec).toEqual(["GET /api/ok"]);
    expect(r.mismatches).toBe(4);

    const report = await readFile(r.reportFile, "utf8");
    expect(report).toContain("**4 mismatch(es) between the docs and the UI.**");
    // each line links to its docs section and to the screen as the walk saw it
    expect(report).toContain('- [Screen "Projects"](../edited.md#screen-projects): button "Archive" — [screen](screenshots/02-projects.png)');
    expect(report).toContain('- [Dialog "New project"](../edited.md#dialog-new-project): the name of a textbox field: "Name" in the docs, "Project name" in the UI — [screen](screenshots/02-projects-overlay-1.png)');
  }, 180_000);

  it("docs it cannot read fail before any browser opens", async () => {
    const file = join(BASE, "notes.md");
    await writeFile(file, "# Notes\n\nNothing in the docs format.\n", "utf8");
    await expect(runCheckDocs({ docs: file, url: start(), browser, out: join(BASE, "notes") })).rejects.toThrow(/^No sections in /);
  });
});
