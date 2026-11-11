import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { loadConfig } from "../../src/config/index.js";
import { runCollectDocs } from "../../src/agent/collect-docs.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";

/**
 * #24: `cairn collect-docs` on a local fixture app (three screens, a modal with a form, a wizard), in real Chromium.
 * The model is a fake that counts its calls: no network beyond localhost, no key.
 */
const BASE = join(process.cwd(), "runs", ".itest-collect-docs");

function fakeModel(): { invoke: StructuredInvoke; calls: () => number } {
  let calls = 0;
  const invoke = (async (_schema: unknown, messages: { content: unknown }[]) => {
    calls++;
    const text = String(messages[0]?.content ?? "");
    const title = /^Title: (.*)$/m.exec(text)?.[1] ?? "?";
    const ids = [...text.matchAll(/^- (overlay-\d+) ·/gm)].map((m) => m[1]!);
    return {
      purpose: `The ${title} screen.`,
      userMight: [`work on ${title}`],
      overlays: ids.map((id) => ({ id, purpose: `purpose of ${id}`, userMight: [] })),
      questions: title === "Settings" ? ['What do "Email alerts" send?'] : [],
    };
  }) as unknown as StructuredInvoke;
  return { invoke, calls: () => calls };
}

describe("cairn collect-docs (integration, real Chromium, fake model)", () => {
  let server: FixtureServer;
  const config = loadConfig({ ANTHROPIC_API_KEY: "test-key-not-used" });
  const cacheDir = join(BASE, "cache");
  const start = (): string => `${server.url}/docs-app/index.html`;

  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
    await rm(BASE, { recursive: true, force: true });
  });

  it("documents every screen, the modal and the wizard, with screenshots; a second walk of the unchanged app makes no LLM call", async () => {
    const model = fakeModel();
    const first = await runCollectDocs({ url: start(), config, out: join(BASE, "first"), cacheDir, describeInvoke: model.invoke });
    const md = await readFile(first.docsFile, "utf8");

    // a section per screen and overlay
    for (const h of ["## Screen: Home", "## Screen: Projects", "## Screen: Settings", "## Dialog: New project", "## Wizard: Setup wizard"]) {
      expect(md).toContain(h);
    }
    expect(first.model.sections.map((s) => `${s.kind}: ${s.title}`)).toEqual([
      "Screen: Home",
      "Screen: Projects",
      "Dialog: New project",
      "Screen: Settings",
      "Wizard: Setup wizard",
    ]);
    // every section has its screenshot on disk
    for (const s of first.model.sections) {
      expect(s.screenshot, `${s.kind} ${s.title}`).toBeDefined();
      expect(md).toContain(`](${s.screenshot})`);
      await access(join(first.outDir, s.screenshot!));
    }

    // what a user can do there, and where it leads
    expect(md).toContain('- Open Dialog "New project" — button "New project"');
    expect(md).toContain('- Go to Screen "Settings" — link "Settings"');
    expect(md).toContain('- Open Wizard "Setup wizard" — button "Start setup"');
    expect(md).toContain('- Press "Export"');
    expect(md).toContain('- Who gets here: the start address; Screen "Projects" — link "Home"; Screen "Settings" — link "Home"');
    expect(md).toContain('- Who gets here: Screen "Home" — link "Projects"; Screen "Settings" — link "Projects"');
    // fields, and which are required
    expect(md).toContain('- "Project name" — textbox, required');
    expect(md).toContain('- "Description" — textbox\n');
    expect(md).toContain('- "Email alerts" — checkbox\n');
    // the overlay: what opens it, its ways out, what completes it
    expect(md).toContain('- Opened from: Screen "Projects" — button "New project"');
    expect(md).toMatch(/- Ways out: Escape, button "Cancel", a click outside it/);
    expect(md).toContain('- Completes with: button "Save"');
    // the wizard's steps, with the validation that blocks Next
    expect(md).toContain('1. Step 1 of 3 — fields: "Company"; Next is blocked until it is filled (the page says: "Company is required")');
    expect(md).toContain('2. Step 2 of 3 — fields: "Team size"\n3. Step 3 of 3; "Back" returns to the step before\n');
    // the model's words where they belong
    expect(md).toContain("- What it is: The Projects screen.");
    expect(md).toContain("- What it is: purpose of overlay-1");

    // what is unclear is a question, never an answer
    const questions = md.slice(md.indexOf("## Questions"));
    expect(questions).toContain('- Screen "Home": What does "SLA" mean?');
    expect(questions).toContain('- Screen "Settings": What do "Email alerts" send?');
    expect(md.slice(0, md.indexOf("## Questions")).match(/SLA/g)).toBeNull();

    // the traffic → an OpenAPI draft; and documenting wrote nothing to the server
    expect(first.openApiFile).toBeDefined();
    expect(await readFile(first.openApiFile!, "utf8")).toContain('"/api/ok"');
    expect(server.writes).toEqual([]);
    expect(model.calls()).toBe(3);
    expect(first.described).toBe(3);

    // a second walk: nothing changed, so no LLM call, and the same docs
    const again = fakeModel();
    const second = await runCollectDocs({ url: start(), config, out: join(BASE, "second"), cacheDir, describeInvoke: again.invoke });
    expect(again.calls()).toBe(0);
    expect(second.cached).toBe(3);
    expect(await readFile(second.docsFile, "utf8")).toBe(md);
  }, 300_000);

  it("an app with nothing on its start page fails with a clear error, and writes nothing", async () => {
    const model = fakeModel();
    const out = join(BASE, "empty");
    await expect(runCollectDocs({ url: `${server.url}/docs-app/empty.html`, config, out, cacheDir, describeInvoke: model.invoke })).rejects.toThrow(
      /^Nothing to document at .*empty\.html: the page shows no heading and no control\./,
    );
    expect(model.calls()).toBe(0);
    await expect(access(out)).rejects.toThrow();
  }, 60_000);

  it("an unreachable address fails with a one-line error, and writes nothing", async () => {
    const model = fakeModel();
    const out = join(BASE, "unreachable");
    const err = await runCollectDocs({ url: "http://127.0.0.1:9/nope", config, out, cacheDir, describeInvoke: model.invoke }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Could not (reach|load) http:\/\/127\.0\.0\.1:9\/nope/);
    expect((err as Error).message).not.toContain("\n");
    expect(model.calls()).toBe(0);
    await expect(access(out)).rejects.toThrow();
  }, 60_000);
});
