import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { capture } from "../../src/observe/index.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import { exploreOverlays } from "../../src/agent/overlays.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";

/**
 * #225 review: overlay exploration must never press a button that changes data. Every risky control on the fixture
 * page POSTs to the fixture server, so "nothing was changed" is read from the server, not from what Cairn says.
 */
describe("overlay exploration changes nothing (integration, real Chromium)", () => {
  let server: FixtureServer;
  let backend: PlaywrightLibBackend;
  const url = (): string => `${server.url}/overlay-safety.html`;

  beforeAll(async () => {
    server = await startFixtureServer();
    backend = new PlaywrightLibBackend({ headless: true });
  });
  afterAll(async () => {
    await backend.close();
    await server.close();
  });

  it("no mutating request reaches the server, and the genuine dialog, drawer, menu and wizard are still found", async () => {
    const gateway = backend as unknown as BrowserGateway;
    const study = await capture(gateway, url());
    // every trigger of the page is tried: none of the risky ones may hide behind the trigger limit
    const out = await exploreOverlays({ gateway, url: url(), study, maxTriggers: 40 });

    // #225 review 3, the invariant: whatever cairn pressed, no request but GET, HEAD or OPTIONS reached the server
    expect(server.writes).toEqual([]);
    expect(server.posts.map((p) => p.url)).toEqual([]);
    expect(out.guard).toBe("network");

    // what the guard stopped is reported, with the element pressed before it
    const blocked = new Map((out.blocked ?? []).map((b) => [b.path, b]));
    for (const [path, method, name] of [
      ["/api/buy", "POST", "Buy plan"],
      ["/api/upgrade", "POST", "Upgrade"],
      ["/api/kupyty", "POST", "Купити"],
      ["/api/pay", "POST", "Pay"],
      ["/api/order", "PUT", "Order"],
      ["/api/checkout", "POST", "Checkout"],
      ["/api/subscribe", "POST", "Subscribe"],
      ["/api/complete-payment", "PATCH", "Complete payment"],
      ["/api/pay-link", "POST", "Pay with card"],
    ] as const) {
      expect(blocked.get(path), path).toMatchObject({ method, pressed: { name } });
    }

    const shortcuts = out.states.find((s) => s.name === "Keyboard shortcuts");
    expect(shortcuts).toMatchObject({ kind: "dialog", trigger: { role: "button", name: "Keyboard shortcuts" } });
    // the click outside found a point on the backdrop, not the "Sign out" link in the corner
    expect(shortcuts!.exits.find((x) => x.kind === "click-outside")).toMatchObject({ verified: true });

    // "Close account" and "Cancel subscription" are actions, not exits
    const account = out.states.find((s) => s.name === "Account settings");
    expect(account!.exits.filter((x) => x.name !== undefined).map((x) => [x.kind, x.name])).toEqual([["close-button", "Close"]]);

    // a confirmation with Continue and no steps is not a wizard
    expect(out.states.find((s) => s.name?.startsWith("Transfer ownership"))?.wizard).toBeUndefined();

    const skipped = out.skipped.map((s) => s.name);
    for (const name of ["Pay now", "Archive", "Continue", "Close account", "Cancel subscription"]) expect(skipped).toContain(name);

    // review 2: «Next: place order» is no wizard step, so the cart with Back and «Step 2 of 2» is no wizard
    expect(out.states.find((s) => s.name === "Cart")?.wizard).toBeUndefined();
    expect(skipped).toContain("Next: place order");
    // review 2: a trigger that submits its form is not pressed, whatever it announces
    const reasonOf = (name: string): string | undefined => out.skipped.find((s) => s.name === name)?.reason;
    expect(reasonOf("Choose options")).toBe("submits a form");
    expect(reasonOf("Show extras")).toBe("submits a form");
    // review 3: a submit button joined to its form by the form attribute submits it too
    expect(reasonOf("Pick a plan")).toBe("submits a form");
    // review 3, the blocker: a wizard Next with no type inside a post form is a submitter; it is not pressed, even once
    const billing = out.states.find((s) => s.name === "Billing wizard");
    expect(billing!.wizard!.steps).toHaveLength(1);
    expect(out.skipped).toContainEqual({ role: "button", name: "Next", reason: "submits a form" });

    // the genuine overlays of the page are still found
    expect(out.states.find((s) => s.name === "Filters panel")).toMatchObject({ kind: "drawer", trigger: { name: "Filters" } });
    expect(out.states.find((s) => s.name === "More actions")).toMatchObject({ kind: "menu", trigger: { name: "More" } });
    // review 3: names that hold "order" and open a menu are menus, not payments
    expect(out.states.find((s) => s.name === "Sort options")).toMatchObject({ kind: "menu", trigger: { name: "Sort order" } });
    expect(out.states.find((s) => s.name === "Date order")).toMatchObject({ kind: "menu", trigger: { name: "Order by date" } });
    const profile = out.states.find((s) => s.name === "Profile wizard");
    expect(profile!.wizard).toMatchObject({ next: "Next", back: "Back", backWorks: true });
    expect(profile!.wizard!.steps).toHaveLength(2);
  }, 180_000);

  it("a disabled Next is not pressed, so a wizard that cannot move on does not wait out the click timeout", async () => {
    const page = `${server.url}/wizard-disabled.html`;
    const gateway = backend as unknown as BrowserGateway;
    const study = await capture(gateway, page);
    const started = Date.now();
    const out = await exploreOverlays({ gateway, url: page, study });
    const elapsed = Date.now() - started;

    const wizard = out.states.find((s) => s.name === "Import wizard");
    expect(wizard?.wizard?.steps).toHaveLength(1);
    expect(wizard!.wizard!.steps[0]!.nextBlocked).toEqual([]);
    expect(elapsed).toBeLessThan(25_000); // one blind click on the disabled Next alone waits 30 s
  }, 180_000);

  it("with no safe point outside the overlay, the click outside is not tried and nothing is clicked", async () => {
    const page = `${server.url}/outside-all-links.html`;
    const gateway = backend as unknown as BrowserGateway;
    const posted = server.posts.length;
    const out = await exploreOverlays({ gateway, url: page, study: await capture(gateway, page) });

    expect(server.posts.slice(posted).map((p) => p.url)).toEqual([]);
    const help = out.states.find((s) => s.name === "Help");
    expect(help!.exits.find((x) => x.kind === "click-outside")).toMatchObject({ notTried: expect.stringContaining("not tried") });
    expect(help!.exits.find((x) => x.kind === "escape")).toMatchObject({ verified: true });
  }, 180_000);
});

/**
 * #225 review 4: the invariant has no end. No write sent because of a press may ever arrive, not while exploring and not
 * after it, however late the page sends it. Each case is read from the server's own log, twice: when exploreOverlays has
 * returned, and after the crawler has opened another page and then this one again.
 */
describe("what a press did never reaches the server later (integration, real Chromium)", () => {
  let server: FixtureServer;
  let backend: PlaywrightLibBackend;
  let gateway: BrowserGateway;
  const paths = (): string[] => server.writes.map((w) => w.url);
  const lateWrites = (kind: string): string => `${server.url}/overlay-late-writes.html?case=${kind}`;
  /** Long enough for a request released at the end of exploring to arrive: they came within 3 ms. */
  const arrival = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

  beforeEach(async () => {
    server = await startFixtureServer();
    backend = new PlaywrightLibBackend({ headless: true });
    gateway = backend as unknown as BrowserGateway;
  });
  afterEach(async () => {
    await backend.close();
    await server.close();
  });

  /** The same press on the crawler's own page, with no guard: the write must arrive, or the zero above it says nothing. */
  async function theWriteIsReal(page: string, expected: string): Promise<void> {
    const obs = await gateway.observe({ url: page });
    const trigger = parseAriaSnapshot(obs.ariaSnapshot).find((e) => e.name === "Open panel")!;
    await gateway.act({ kind: "click", ref: trigger.ref, watch: false });
    await arrival();
    await gateway.observe({ url: `${server.url}/list.html` });
    await gateway.observe({ url: page });
    await expect.poll(paths, { timeout: 5_000 }).toContain(expected);
  }

  const SHELL = "headless shell";
  const FULL = "full Chromium"; // what a configured browser channel runs on: it lets out what the shell lost
  it.each([
    // the three that arrived after the guard of review 3 was lifted
    { kind: "pagehide", write: "/w/pagehide", on: SHELL },
    { kind: "popup-realm", write: "/w/popup-realm", on: SHELL },
    { kind: "outbox", write: "/w/outbox", on: SHELL },
    // what a page, a frame or a popup sends as it goes: a route's interception goes with it, and lets go of what it held
    { kind: "self-closing-popup", write: "/w/on-the-way-out", on: SHELL },
    { kind: "removed-frame", write: "/w/on-the-way-out", on: FULL }, // a process of its own only in full Chromium
    // these send where no route sees them: they arrived with a route on
    { kind: "shared-worker", write: "/w/shared-worker", on: SHELL },
    { kind: "fetch-later", write: "/w/fetch-later", on: SHELL },
    { kind: "background-fetch", write: "/w/background-fetch", on: FULL }, // the shell has none
    // writes that never stop: some are on their way whenever the guard might end; a context closing lets them out
    { kind: "storm", write: "/w/storm", on: SHELL },
    { kind: "storm", write: "/w/storm", on: FULL },
    { kind: "pagehide", write: "/w/pagehide", on: FULL },
  ])("$kind, $on: the server's log is empty after exploring and after the crawler comes back", async ({ kind, write, on }) => {
    if (on === FULL) {
      backend = new PlaywrightLibBackend({ headless: true, channel: "chromium" });
      gateway = backend as unknown as BrowserGateway;
    }
    const page = lateWrites(kind);
    const out = await exploreOverlays({ gateway, url: page, study: await capture(gateway, page) });
    expect(out.guard).toBe("network");
    expect(out.states.map((s) => s.name)).toContain("Panel"); // it was pressed: the overlay it opens was found

    await arrival();
    expect(server.writes).toEqual([]);

    await gateway.observe({ url: `${server.url}/list.html` });
    await gateway.observe({ url: page });
    await arrival();
    expect(server.writes).toEqual([]);

    await theWriteIsReal(page, write);
  }, 180_000);

  it.each([
    // held by the guard of review 3 already, and reported: they stay so
    { kind: "immediate", write: "/w/immediate" },
    { kind: "popup-page", write: "/w/on-load" },
    { kind: "srcdoc", write: "/w/srcdoc" },
    { kind: "cross-origin-frame", write: "/w/on-load", blockedPath: /^http:\/\/localhost:\d+\/w\/on-load$/ },
    { kind: "service-worker", write: "/w/service-worker" },
  ])("$kind: stopped and reported", async ({ kind, write, blockedPath }) => {
    const page = lateWrites(kind);
    const out = await exploreOverlays({ gateway, url: page, study: await capture(gateway, page) });
    await arrival();
    expect(server.writes).toEqual([]);
    expect(out.blocked).toContainEqual(expect.objectContaining({ method: "POST", path: blockedPath ? expect.stringMatching(blockedPath) : write }));
    await gateway.observe({ url: `${server.url}/list.html` });
    await gateway.observe({ url: page });
    await arrival();
    expect(server.writes).toEqual([]);
    await theWriteIsReal(page, write);
  }, 180_000);

  it("a route already on the crawler's context that lets everything through changes nothing", async () => {
    const page = lateWrites("immediate");
    const study = await capture(gateway, page);
    const live = (backend as unknown as { context: { route(p: string, h: (r: { continue(): Promise<void> }) => Promise<void>): Promise<void> } }).context;
    await live.route("**/*", (r) => r.continue());
    const out = await exploreOverlays({ gateway, url: page, study });
    await arrival();
    expect(server.writes).toEqual([]);
    expect(out.blocked).toContainEqual(expect.objectContaining({ method: "POST", path: "/w/immediate" }));
  }, 180_000);

  it("the crawler's own page never saw a press: the same document, the same refs, the same storage", async () => {
    const page = lateWrites("outbox");
    const study = await capture(gateway, page);
    const saved = await gateway.session().save();
    const out = await exploreOverlays({ gateway, url: page, study });
    expect(out.states.map((s) => s.name)).toContain("Panel");

    // nothing a press stored came back
    expect(await gateway.session().save()).toEqual(saved);
    // a ref read before exploring still acts, with nothing observed since, and on the same document: its load number
    const trigger = study.elements.find((e) => e.name === "Open panel")!;
    expect(await gateway.act({ kind: "click", ref: trigger.ref, watch: false })).toMatchObject({ ok: true });
    const after = (await gateway.observe({})).ariaSnapshot;
    expect(after).toContain('dialog "Panel"');
    expect(after).toContain(/Load [\d.]+/.exec(study.ariaYaml)![0]);
  }, 180_000);

  it("a session kept in sessionStorage or IndexedDB goes in with the pressing, and nothing comes back out", async () => {
    const page = `${server.url}/overlay-signed-in.html`;
    await gateway.observe({ url: `${page}?signin=1` });
    const study = await capture(gateway, page);
    for (const name of ["Session settings", "Local settings", "Database settings", "Cookie settings"]) {
      expect(study.elements.map((e) => e.name)).toContain(name); // signed in on the crawler's page
    }
    const out = await exploreOverlays({ gateway, url: page, study });

    // each trigger shows only when its store holds the session: it was seen and pressed in the pressing context too
    expect(out.states.map((s) => s.trigger.name).sort()).toEqual(["Cookie settings", "Database settings", "Local settings", "Session settings"]);
    // every press marked all four stores, and the crawler's page, loaded again, finds no mark in any
    expect((await gateway.observe({ url: page })).ariaSnapshot).toContain("Pressed: none");
  }, 180_000);

  it("a site behind HTTP Basic Auth is explored with the same credentials, and its writes are stopped too", async () => {
    await server.close();
    server = await startFixtureServer({ basicAuth: "john:doe" });
    backend = new PlaywrightLibBackend({ headless: true, httpCredentials: { username: "john", password: "doe" } });
    gateway = backend as unknown as BrowserGateway;
    const page = lateWrites("immediate");
    const out = await exploreOverlays({ gateway, url: page, study: await capture(gateway, page) });
    expect(out.states.map((s) => s.name)).toContain("Panel"); // without the credentials the page answers 401: no trigger
    await arrival();
    expect(server.writes).toEqual([]);
    expect(out.blocked).toContainEqual(expect.objectContaining({ method: "POST", path: "/w/immediate" }));
  }, 180_000);

  it("a throw out of the pressing still rejects, and lifts the guard: the crawler's next write reaches the server", async () => {
    const page = lateWrites("immediate");
    const study = await capture(gateway, page);
    // outside the per-trigger catch: reading what a button announces, before any trigger is pressed
    const broken = vi.spyOn(backend, "getState").mockImplementation(() => {
      throw new Error("state read broke");
    });
    await expect(exploreOverlays({ gateway, url: page, study })).rejects.toThrow("state read broke");
    broken.mockRestore();

    await gateway.observe({ url: lateWrites("on-load") });
    await expect.poll(() => server.writes, { timeout: 5_000 }).toEqual([{ method: "POST", url: "/w/on-load" }]);
  }, 180_000);
});
