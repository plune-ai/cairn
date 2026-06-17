import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mock state (vi.hoisted so the factories below can see it).
const h = vi.hoisted(() => ({ exePath: "" as string, exists: false }));
vi.mock("playwright", () => ({
  chromium: {
    executablePath: () => {
      if (!h.exePath) throw new Error("Executable doesn't exist"); // recent Playwright behavior
      return h.exePath;
    },
  },
}));
vi.mock("node:fs", () => ({ existsSync: () => h.exists }));

import {
  isMissingBrowserError,
  missingBrowsersError,
  chromiumInstalled,
  ensureBrowsersInstalled,
  INSTALL_BROWSERS_HINT,
} from "../../src/browser/preflight.js";

beforeEach(() => {
  h.exePath = "";
  h.exists = false;
});

describe("isMissingBrowserError — recognizes Playwright's missing-browser signature", () => {
  it("matches the real launch error the user hit", () => {
    const real =
      "browserType.launch: Executable doesn't exist at " +
      "C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell.exe";
    expect(isMissingBrowserError(real)).toBe(true);
    expect(isMissingBrowserError(new Error(real))).toBe(true);
  });

  it("matches the 'please run … playwright install' banner", () => {
    expect(isMissingBrowserError("Please run the following command to download new browsers")).toBe(true);
    expect(isMissingBrowserError("npx playwright install")).toBe(true);
  });

  it("does NOT match unrelated errors or empty/non-string values", () => {
    expect(isMissingBrowserError("Timeout 30000ms exceeded")).toBe(false);
    expect(isMissingBrowserError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isMissingBrowserError("")).toBe(false);
    expect(isMissingBrowserError(null)).toBe(false);
    expect(isMissingBrowserError(undefined)).toBe(false);
  });
});

describe("missingBrowsersError — clean, actionable error", () => {
  it("carries the install command and a stable name (no stack noise needed)", () => {
    const e = missingBrowsersError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BrowsersNotInstalledError");
    expect(e.message).toContain("npx playwright install chromium");
    // The error it produces must be recognizable by our own detector (round-trip).
    expect(isMissingBrowserError(e)).toBe(true);
  });

  it("INSTALL_BROWSERS_HINT is the single source of the command string", () => {
    expect(INSTALL_BROWSERS_HINT).toContain("npx playwright install chromium");
  });
});

describe("ensureBrowsersInstalled — preflight gate", () => {
  it("throws an actionable error when the bundled Chromium is absent", () => {
    h.exePath = "C:\\ms-playwright\\chromium\\chrome.exe";
    h.exists = false; // path computed, but the binary is not on disk
    expect(() => ensureBrowsersInstalled()).toThrow(/npx playwright install chromium/);
    expect(chromiumInstalled()).toBe(false);
  });

  it("passes silently when the bundled Chromium is present", () => {
    h.exePath = "C:\\ms-playwright\\chromium\\chrome.exe";
    h.exists = true;
    expect(() => ensureBrowsersInstalled()).not.toThrow();
    expect(chromiumInstalled()).toBe(true);
  });

  it("is SKIPPED when a system browser channel is configured (uses system Chrome/Edge, not the bundle)", () => {
    h.exePath = "";
    h.exists = false; // bundled chromium missing…
    // …but a channel means Playwright drives the system browser → preflight must not block.
    expect(() => ensureBrowsersInstalled({ channel: "chrome" })).not.toThrow();
  });
});
