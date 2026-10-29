import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";

describe("playwright-lib backend (integration, real Chromium)", () => {
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

  it("observe() returns aria + screenshot from the login fixture", async () => {
    const obs = await backend.observe({ url: `${server.url}/login.html` });
    expect(obs.capturedBy).toBe("lib");
    expect(obs.ariaSnapshot).toContain("Sign in");
    expect(obs.ariaSnapshot).toContain("Sign In"); // button
    expect(obs.screenshotB64.length).toBeGreaterThan(500);
  });

  it("act fill+click → session.save() contains localStorage + cookie", async () => {
    const obs = await backend.observe({ url: `${server.url}/login.html` });
    const els = parseAriaSnapshot(obs.ariaSnapshot);
    const email = els.find((e) => e.role === "textbox" && e.name === "Email");
    const signIn = els.find((e) => e.role === "button" && e.name === "Sign In");
    if (!email || !signIn) throw new Error("email/signIn not found in the snapshot");

    await backend.act({ kind: "fill", ref: email.ref, value: "a@b.com" });
    const clicked = await backend.act({ kind: "click", ref: signIn.ref });
    expect(clicked.ok).toBe(true);

    const state = await backend.session().save();
    const ls = state.origins
      .flatMap((o) => o.localStorage)
      .find((l) => l.name === "qa_session");
    expect(ls?.value).toBe("active");
    expect(state.cookies.some((c) => c.name === "qa_demo")).toBe(true);
  });

  it("getState reads a visible checkbox, and answers at once for one that is not on the page (#213)", async () => {
    await backend.observe({ url: `${server.url}/login.html` });
    const remember = await backend.getState({ ref: "e1", role: "checkbox", name: "Remember me", interactive: true, rank: 3 });
    expect(remember).toEqual({ visible: true, enabled: true, checked: false });
    // A checkbox exploreStates saw in another view: not attached here. Playwright's default wait is 30 s per read.
    const started = Date.now();
    const elsewhere = await backend.getState({ ref: "e2", role: "checkbox", name: "Only in another view", interactive: true, rank: 3 });
    expect(elsewhere).toEqual({ visible: false, enabled: false, checked: undefined });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
