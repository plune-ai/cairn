import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { capture } from "../../src/observe/index.js";
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
    const out = await exploreOverlays({ gateway, url: url(), study, maxTriggers: 20 });

    expect(server.posts.map((p) => p.url)).toEqual([]);

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
    // review 2: a trigger whose name pays or orders is not pressed
    for (const name of ["Buy plan", "Upgrade", "Купити"]) expect(reasonOf(name)).toBe("destructive");

    // the genuine overlays of the page are still found
    expect(out.states.find((s) => s.name === "Filters panel")).toMatchObject({ kind: "drawer", trigger: { name: "Filters" } });
    expect(out.states.find((s) => s.name === "More actions")).toMatchObject({ kind: "menu", trigger: { name: "More" } });
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
