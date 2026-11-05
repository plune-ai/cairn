import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import { capture } from "../../src/observe/index.js";
import { exploreOverlays } from "../../src/agent/overlays.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";
import type { ElementRef } from "../../src/browser/types.js";

/** #225: overlays as states, on the real fixture page in real Chromium. */
describe("overlays as explore states (integration, real Chromium)", () => {
  let server: FixtureServer;
  let backend: PlaywrightLibBackend;
  const url = (): string => `${server.url}/overlays.html`;

  beforeAll(async () => {
    server = await startFixtureServer();
    backend = new PlaywrightLibBackend({ headless: true });
  });
  afterAll(async () => {
    await backend.close();
    await server.close();
  });

  async function read(): Promise<{ els: ElementRef[]; aria: string }> {
    const obs = await backend.observe({});
    return { els: parseAriaSnapshot(obs.ariaSnapshot, { nonModal: new Set(obs.nonModal ?? []) }), aria: obs.ariaSnapshot };
  }
  const clickNamed = async (els: ElementRef[], name: string, scoped?: boolean) => {
    const el = els.find((e) => e.role === "button" && e.name === name && (scoped === undefined || !!e.scope === scoped));
    if (!el) throw new Error(`no button "${name}"`);
    return backend.act({ kind: "click", ref: el.ref });
  };

  it("a Save in the modal is clicked inside the modal; the page's Save under it is not clicked at all", async () => {
    await backend.observe({ url: url() });
    const closed = await read();
    expect((await clickNamed(closed.els, "New project")).outcome).toBe("overlay-opened");
    const open = await read();

    // the same name twice in the snapshot: one on the page (under the modal), one in the dialog
    const saves = open.els.filter((e) => e.role === "button" && e.name === "Save");
    expect(saves).toHaveLength(2);

    const page = await clickNamed(open.els, "Save", false);
    expect(page.ok).toBe(false);
    expect(page.outcome).toBe("under-overlay");

    const modal = await clickNamed(open.els, "Save", true);
    expect(modal.ok).toBe(true);
    const after = await read();
    expect(after.aria).toContain("Name is required"); // the modal's Save ran (empty name → validation)
    expect(after.aria).toContain("Page saves: 0"); // the page's Save did not
  });

  it("verify and getState look in the scope too", async () => {
    await backend.observe({ url: url() });
    await clickNamed((await read()).els, "New project");
    const { els } = await read();
    const verified = await backend.verify!(els.filter((e) => e.role === "button" && e.name === "Save"));
    expect(verified.map((v) => [v.count, v.verified])).toEqual([
      [2, false], // the page's Save, while the modal is open: the page-wide locator also matches the dialog's (and it lies under the modal anyway)
      [1, true], // the dialog's Save: one inside the dialog
    ]);
  });

  it("Escape and a click outside are actions of the lib backend", async () => {
    await backend.observe({ url: url() });
    await clickNamed((await read()).els, "New project");
    expect((await backend.act({ kind: "press", key: "Escape" })).ok).toBe(true);
    expect((await read()).aria).not.toContain("dialog");
  });

  it("finds the modal, the nested confirmation, the drawer, the menu and the 3-step wizard as states, with triggers and exits", async () => {
    const gateway = backend as unknown as BrowserGateway;
    const study = await capture(gateway, url());
    const progress: string[] = [];
    const out = await exploreOverlays({ gateway, url: url(), study, onProgress: (e) => progress.push(e) });
    const by = (name: string) => out.states.find((s) => s.name === name);

    const modal = by("New project");
    expect(modal).toMatchObject({ kind: "dialog", modal: true, trigger: { role: "button", name: "New project" } });
    expect(modal!.parent).toBeUndefined();
    const exit = (s: typeof modal, kind: string) => s!.exits.find((x) => x.kind === kind);
    expect(exit(modal, "escape")).toMatchObject({ verified: true });
    expect(exit(modal, "click-outside")).toMatchObject({ verified: true });
    expect(exit(modal, "close-button")).toMatchObject({ name: "Close" });
    expect(exit(modal, "cancel")).toMatchObject({ name: "Cancel" });
    expect(exit(modal, "submit")).toMatchObject({ name: "Save", safe: true });
    // elements inside carry locators scoped to the dialog
    expect(modal!.elements.find((e) => e.name === "Save")!.locator).toContain("page.getByRole('dialog', { name: 'New project', exact: true })");

    const confirm = by("Are you sure?");
    expect(confirm).toMatchObject({ kind: "alertdialog", parent: modal!.id, trigger: { role: "button", name: "Discard changes" } });

    const drawer = by("Details panel");
    expect(drawer).toMatchObject({ kind: "drawer", modal: false, trigger: { role: "button", name: "Details" } });
    expect(exit(drawer, "escape")).toMatchObject({ verified: true });

    const menu = by("Project actions");
    expect(menu).toMatchObject({ kind: "menu", modal: false, trigger: { role: "button", name: "Actions" } });
    expect(menu!.elements.map((e) => e.name)).toEqual(["Rename", "Duplicate", "Archive"]);

    const wizard = by("Setup wizard");
    expect(wizard!.wizard!.steps).toHaveLength(3);
    expect(wizard!.wizard).toMatchObject({ next: "Next", back: "Back", backWorks: true });
    expect(wizard!.wizard!.steps[0]!.nextBlocked).toEqual(["Company is required"]);
    expect(wizard!.wizard!.steps[1]!.nextBlocked).toBeUndefined();

    // toasts are recorded as text, never states
    expect(out.states.some((s) => s.name === "Project saved")).toBe(false);
  }, 180_000);

  it("opening is safe, Submit and Delete are not pressed", async () => {
    const { aria } = await (async () => {
      const obs = await backend.observe({ url: url() });
      return { aria: obs.ariaSnapshot };
    })();
    const gateway = backend as unknown as BrowserGateway;
    const study = await capture(gateway, url());
    const out = await exploreOverlays({ gateway, url: url(), study });
    const after = (await backend.observe({ url: url() })).ariaSnapshot;
    expect(aria).toContain("deleted: no");
    expect(after).toContain("deleted: no"); // "Delete project" was never clicked
    expect(after).toContain("Page saves: 0"); // nor the page's Save
    expect(out.skipped.map((s) => s.name)).toContain("Delete project");
  }, 180_000);
});
