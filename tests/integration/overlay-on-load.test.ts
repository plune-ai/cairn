import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { capture } from "../../src/observe/index.js";
import { exploreOverlays } from "../../src/agent/overlays.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";

/** A layer open on load, and a combobox with a popup, are overlay states (real Chromium, fixture pages). */
describe("overlays open on load and comboboxes (integration, real Chromium)", () => {
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

  async function explore(page: string) {
    const gateway = backend as unknown as BrowserGateway;
    const url = `${server.url}/${page}`;
    const study = await capture(gateway, url);
    return exploreOverlays({ gateway, url, study });
  }

  it("a plain div modal open on load is an overlay state with no trigger", async () => {
    const out = await explore("overlay-on-load.html");
    expect(out.states).toHaveLength(1);
    const modal = out.states[0]!;
    expect(modal.kind).toBe("dialog");
    expect(modal.name).toBe("This is a modal window");
    expect(modal.modal).toBe(true);
    expect(modal.trigger.role).toBe("page"); // open when the page was read: nothing opened it
  });

  it("a combobox that announces a popup is pressed, and the listbox it opens is a state", async () => {
    const out = await explore("combobox-popup.html");
    expect(out.skipped.map((s) => s.name)).not.toContain("Pick a colour");
    const list = out.states.find((s) => s.kind === "listbox");
    expect(list?.trigger).toMatchObject({ role: "combobox", name: "Pick a colour" });
    expect(out.note ?? "").not.toContain("nothing was pressed");
  });
});
