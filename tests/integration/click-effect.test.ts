import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import type { ActResult } from "../../src/browser/types.js";

/** #224: a click says what it did — or, when it failed, why — on the real fixture page, in real Chromium. */
describe("a click records its effect, and a failed click names its cause (integration, real Chromium)", () => {
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

  /** Opens the click page; `click(name)` then clicks a button of that observation (its refs stay valid). */
  async function open(): Promise<(name: string, timeoutMs?: number) => Promise<ActResult>> {
    const els = parseAriaSnapshot((await backend.observe({ url: `${server.url}/clicks.html` })).ariaSnapshot);
    return (name, timeoutMs) => {
      const button = els.find((e) => e.role === "button" && e.name === name);
      if (!button) throw new Error(`no button "${name}" in the snapshot`);
      return backend.act({ kind: "click", ref: button.ref, ...(timeoutMs ? { timeoutMs } : {}) });
    };
  }
  const click = async (name: string): Promise<ActResult> => (await open())(name);

  it("a button that changes the URL → navigated", async () => {
    const r = await click("Go to the list");
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("navigated");
    expect(r.effect?.page).toBe(`${server.url}/clicks.html`);
    expect(r.effect?.url).toBe(`${server.url}/list.html`);
  });

  it("a button that opens a dialog → overlay-opened, with the dialog named", async () => {
    const r = await click("Open the editor");
    expect(r.outcome).toBe("overlay-opened");
    expect(r.effect?.opened).toEqual(['dialog "Editor"']);
  });

  it("a button that only sends a POST answered 2xx → network-only, with method, path and status", async () => {
    const r = await click("Save quietly");
    expect(r.outcome).toBe("network-only");
    expect(r.effect?.requests).toEqual([{ method: "POST", path: "/api/save?token=‹redacted›&page=2", status: 204 }]);
  });

  it("a button that does nothing → no-effect, and ok still says the click happened", async () => {
    const r = await click("Does nothing");
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("no-effect");
    expect(r.effect).toMatchObject({ role: "button", name: "Does nothing", page: `${server.url}/clicks.html`, requests: [] });
  });

  it("a button covered by a modal → intercepted, not a general timeout", async () => {
    const on = await open();
    expect((await on("Open the editor")).outcome).toBe("overlay-opened");
    const r = await on("Does nothing", 3_000);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("intercepted");
    expect(r.error).toContain("intercepts pointer events");
  });

  it("the recorded request carries no Authorization, no Cookie and no token-like query value — the page sent all three", async () => {
    server.posts.length = 0;
    const r = await click("Save quietly");
    // What the page really sent: the record below is clean because Cairn dropped it, not because it was never there.
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]?.headers.authorization).toBe("Bearer s3cretBearer42");
    expect(server.posts[0]?.headers.cookie).toContain("sid=c00kieV4lue");
    expect(server.posts[0]?.url).toContain("token=abc123XYZ789");

    const recorded = JSON.stringify(r.effect?.requests);
    expect(recorded).toContain("/api/save");
    expect(recorded).not.toMatch(/authorization|cookie|bearer/i);
    expect(recorded).not.toContain("s3cretBearer42");
    expect(recorded).not.toContain("c00kieV4lue");
    expect(recorded).not.toContain("abc123XYZ789");
  });
});
