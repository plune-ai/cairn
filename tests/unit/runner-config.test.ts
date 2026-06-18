import { describe, it, expect } from "vitest";
import { configContent } from "../../src/validate/runner.js";

/**
 * FIX B (0.3.3): `--channel chrome` / `BROWSER_CHANNEL=chrome` must reach the generated
 * `playwright.config` so `automate --validate` drives the user's system Chrome — no bundled
 * Chromium download. Before the fix the channel never made it into `use`, so even when the preflight
 * was skipped the runner still launched (and demanded) the bundled build.
 */
describe("configContent — system-browser channel threading", () => {
  it("emits use.channel when a channel is provided", () => {
    const cfg = configContent("/runs/x", undefined, "chrome");
    expect(cfg).toMatch(/channel:\s*['"]chrome['"]/);
  });

  it("omits channel entirely when none is provided (bundled Chromium)", () => {
    const cfg = configContent("/runs/x", undefined);
    expect(cfg).not.toMatch(/channel:/);
  });

  it("keeps the storageState and channel together for authenticated system-Chrome runs", () => {
    const cfg = configContent("/runs/x", "/abs/state.json", "chrome");
    expect(cfg).toContain("storageState");
    expect(cfg).toMatch(/channel:\s*['"]chrome['"]/);
  });
});

describe("configContent — Playwright worker count", () => {
  it("emits the given worker count at the top level", () => {
    expect(configContent("/runs/x", undefined, undefined, 3)).toMatch(/workers:\s*3/);
  });

  it("defaults to 5 workers when none is provided", () => {
    expect(configContent("/runs/x")).toMatch(/workers:\s*5/);
  });
});
