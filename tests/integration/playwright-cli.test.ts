import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightCliBackend } from "../../src/browser/backends/playwright-cli.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";

// @playwright/cli is an OPTIONAL peer dependency (the experimental SECONDARY backend, ADR-0003) — the
// default install ships a single stable playwright-core and does NOT pull it (0.3.3). Skip this
// integration test when it isn't installed, rather than crashing the suite.
const cliAvailable = ((): boolean => {
  try {
    createRequire(import.meta.url).resolve("@playwright/cli/package.json");
    return true;
  } catch {
    return false;
  }
})();

// Spike S3: SECONDARY backend via @playwright/cli (spawn-based, headless). Requires an http origin.
describe.skipIf(!cliAvailable)("playwright-cli backend (integration, Spike S3)", () => {
  let server: FixtureServer;
  let backend: PlaywrightCliBackend;

  beforeAll(async () => {
    server = await startFixtureServer();
    backend = new PlaywrightCliBackend({ session: "qa-s3-itest" });
  });
  afterAll(async () => {
    await backend.close();
    await server.close();
  });

  it("observe() → aria with native refs + screenshot (cli)", { timeout: 90000 }, async () => {
    const obs = await backend.observe({ url: `${server.url}/login.html` });
    expect(obs.capturedBy).toBe("cli");
    expect(obs.ariaSnapshot).toContain("Sign In");
    expect(obs.screenshotB64.length).toBeGreaterThan(500);

    const els = parseAriaSnapshot(obs.ariaSnapshot);
    const signIn = els.find((e) => e.role === "button" && e.name === "Sign In");
    expect(signIn).toBeDefined();
    // cli emits native refs — parseAriaSnapshot should pick them up (shape parity with lib).
    expect(signIn?.ref).toMatch(/^e\d+$/);
  });

  it("act click by native ref → ok", { timeout: 90000 }, async () => {
    const obs = await backend.observe({ url: `${server.url}/login.html` });
    const signIn = parseAriaSnapshot(obs.ariaSnapshot).find(
      (e) => e.role === "button" && e.name === "Sign In",
    );
    if (!signIn) throw new Error("Sign In button not found in the cli snapshot");
    const res = await backend.act({ kind: "click", ref: signIn.ref });
    expect(res.ok).toBe(true);
  });
});
