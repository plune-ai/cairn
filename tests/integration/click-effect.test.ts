import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import type { Page } from "playwright";
import type { ActResult } from "../../src/browser/types.js";

/** #224: a click says what it did — or, when it failed, why — on the real fixture page, in real Chromium. */
describe("a click records its effect, and a failed click names its cause (integration, real Chromium)", () => {
  let server: FixtureServer;
  let cross: FixtureServer; // another origin: its own port
  let backend: PlaywrightLibBackend;

  beforeAll(async () => {
    server = await startFixtureServer();
    cross = await startFixtureServer();
    backend = new PlaywrightLibBackend({ headless: true });
  });
  afterAll(async () => {
    await backend.close();
    await server.close();
    await cross.close();
  });

  /** Opens a page; `click(name)` then clicks an element of that observation (its refs stay valid). */
  async function open(path = "/clicks.html"): Promise<(name: string, opts?: { timeoutMs?: number; role?: string; watch?: boolean }) => Promise<ActResult>> {
    const els = parseAriaSnapshot((await backend.observe({ url: `${server.url}${path}` })).ariaSnapshot);
    return (name, { role = "button", ...opts } = {}) => {
      const el = els.find((e) => e.role === role && e.name === name);
      if (!el) throw new Error(`no ${role} "${name}" in the snapshot`);
      return backend.act({ kind: "click", ref: el.ref, ...opts });
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
    expect(r.effect?.requests).toEqual([{ method: "POST", path: "/api/save?token=‹v›&page=‹v›", status: 204 }]);
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
    const r = await on("Does nothing", { timeoutMs: 3_000 });
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

  // Working controls whose effect is late, quiet or outside the page: each one's right outcome, never no-effect.
  const effects = (): string => `/effects.html?cross=${encodeURIComponent(cross.url)}`;
  it.each([
    ["button", "Debounced", "content-changed"], // its text comes 400 ms later
    ["button", "Push late", "navigated"], // pushState 400 ms later
    ["button", "New tab", "opened-tab"], // window.open
    ["link", "Help in new tab", "opened-tab"], // target=_blank
    ["link", "Late tab", "opened-tab"], // target=_blank, its tab open 1.5 s later
    ["button", "Flash", "content-changed"], // a toast gone after 150 ms
    ["button", "Cross-origin load", "content-changed"], // renders once another origin answers, 600 ms later
    ["button", "Focus search", "state-changed"], // moves the focus only
    ["button", "Download", "downloaded"], // a blob download
    ["button", "Lazy chunk", "content-changed"], // renders once its script arrives, 600 ms later
    ["button", "Back to top", "state-changed"], // scrolls only
    ["link", "Slow page", "navigated"], // its page answers after 3 s; the click waits for a link's navigation
    ["button", "Nothing", "no-effect"], // the one dead control on the page
  ])("%s \"%s\" → %s", async (role, name, outcome) => {
    const r = await (await open(effects()))(name, { role });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe(outcome);
  });

  it("a click whose next page is still on its way is unknown, and that page is not waited for", async () => {
    const on = await open(effects());
    const started = Date.now();
    const r = await on("Slow redirect"); // goes to a page that answers after 10 s
    expect(r.outcome).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it("the record says what the quiet effects were: the toast's text, the focus, the scroll, the tab, the file", async () => {
    const on = async (name: string, role = "button"): Promise<ActResult> => (await open(effects()))(name, { role });
    expect((await on("Flash")).effect?.appeared).toContain("Saved!");
    expect((await on("Focus search")).effect?.state.map((s) => s.attr)).toEqual(["focus"]);
    expect((await on("Back to top")).effect?.state).toEqual([{ attr: "scroll", before: expect.not.stringMatching(/^0,0$/), after: "0,0" }]);
    expect((await on("New tab")).effect?.tab).toBe(`${server.url}/list.html`);
    expect((await on("Download")).effect?.download).toBe("report.txt");
    // Another origin's answer is waited for, but only the page's own origin is recorded.
    expect((await on("Cross-origin load")).effect?.requests).toEqual([]);
  });

  it("polling is no effect: a dead button on a page that polls stays no-effect, and the polls are not recorded", async () => {
    for (const path of ["/poll.html", "/poll.html?long=1"]) {
      const r = await (await open(path))("Nothing");
      expect(r.outcome).toBe("no-effect");
      expect(r.effect?.requests).toEqual([]);
    }
  });

  it("an element that went away names how: hidden → not-visible, removed or renamed → not-found", async () => {
    const page = (): Page => (backend as unknown as { page: Page }).page;
    const after = async (change: string): Promise<ActResult> => {
      const on = await open(effects());
      await page().evaluate(change);
      return on("Nothing", { timeoutMs: 1_500 });
    };
    expect((await after(`document.getElementById("nothing").style.display = "none"`)).outcome).toBe("not-visible");
    expect((await after(`document.getElementById("nothing").remove()`)).outcome).toBe("not-found");
    expect((await after(`document.getElementById("nothing").textContent = "Renamed"`)).outcome).toBe("not-found");
  });

  it("watch: false clicks and records nothing — a probe's revert, a sign-in", async () => {
    const r = await (await open())("Open the editor", { watch: false });
    expect(r).toEqual({ ok: true, ref: expect.any(String) });
  });
});
