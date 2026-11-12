import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { PlaywrightLibBackend } from "../../src/browser/backends/playwright-lib.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";

describe("verify marks an element outside the viewport (real Chromium)", () => {
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

  it("a skip link parked at top: -10em is offViewport; a link on the page is not", async () => {
    const obs = await backend.observe({ url: `${server.url}/offscreen-link.html` });
    const links = parseAriaSnapshot(obs.ariaSnapshot).filter((e) => e.role === "link");
    const out = await backend.verify(links);
    expect(out.map((v) => [v.name, v.count, v.offViewport === true])).toEqual([
      ["Skip to content", 1, true],
      ["Other page", 1, false],
    ]);
  });
});
