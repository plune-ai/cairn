import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FIX B regression (0.3.3): the exact consumer scenario — a project that already has its OWN Playwright,
 * driving system Chrome via `--channel chrome` / `BROWSER_CHANNEL=chrome` while NO bundled Chromium is
 * present. Cairn must NOT falsely report "browsers are not installed" on that path, yet must still fire
 * the guard for the bundled path (no channel).
 */
const h = vi.hoisted(() => ({ exePath: "" as string, exists: false }));
vi.mock("playwright", () => ({
  chromium: {
    executablePath: (): string => {
      if (!h.exePath) throw new Error("Executable doesn't exist");
      return h.exePath;
    },
  },
}));
vi.mock("node:fs", () => ({ existsSync: () => h.exists }));

import { ensureBrowsersInstalled } from "../../src/browser/preflight.js";
import { loadConfig } from "../../src/config/index.js";
import { resolveConfig } from "../../src/core/config.js";

beforeEach(() => {
  h.exePath = ""; // bundled Chromium absent…
  h.exists = false; // …and nothing on disk either
});

describe("channel reaches config", () => {
  it("loadConfig surfaces the channel from BROWSER_CHANNEL", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x", BROWSER_CHANNEL: "chrome" });
    expect(cfg.browser.channel).toBe("chrome");
  });

  it("resolveConfig maps the --channel flag over env", () => {
    const cfg = resolveConfig({ channel: "chrome" }, { ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(cfg.browser.channel).toBe("chrome");
  });
});

describe("preflight with a system-browser channel", () => {
  it("does NOT report 'not installed' when a channel is configured (drives system Chrome, no download)", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x", BROWSER_CHANNEL: "chrome" });
    expect(() => ensureBrowsersInstalled({ channel: cfg.browser.channel })).not.toThrow();
  });

  it("STILL fires for the bundled path (no channel) — the guard is not weakened", () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(cfg.browser.channel).toBeUndefined();
    expect(() => ensureBrowsersInstalled({ channel: cfg.browser.channel })).toThrow(
      /cairn install-browsers/,
    );
  });
});
