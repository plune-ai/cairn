import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describeBrowserState } from "./install.js";

/**
 * Browser preflight (onboarding guardrail).
 *
 * `npm install @plune-ai/cairn` pulls the `playwright` *library* but NOT the browser *binaries* —
 * those are a separate download. On a fresh machine `chromium.launch()` (observe/design) and the
 * `@playwright/test` runner (automate --validate) therefore die with a raw "Executable doesn't exist …"
 * deep inside the run, which surfaces as a misleading "0% green · N failed".
 *
 * This module turns that into one clear, actionable message — and lets callers fail fast BEFORE
 * spending any LLM calls. Two layers cooperate (defense in depth):
 *   1. {@link ensureBrowsersInstalled} — a cheap up-front check (is the bundled Chromium on disk?),
 *      SKIPPED when a system-browser channel is configured (then no bundled build is needed).
 *   2. {@link isMissingBrowserError} — a string/error detector used as a backstop where a launch
 *      actually fails (e.g. the headless-shell binary is missing while full Chromium is present).
 *
 * 0.3.3: the fix message points at cairn's OWN installer (`cairn install-browsers`) + the system-Chrome
 * escape hatch (`--channel chrome`) — never the generic `npx playwright install`, which resolved to the
 * host project's Playwright and so never fixed it. The diagnostics come from {@link describeBrowserState}.
 */

/** The single source of truth for the TWO exact fixes we point users at (see install.ts / doctor). */
export const INSTALL_BROWSERS_HINT =
  "Fix it one of two ways:\n" +
  "  1. Download the matching Chromium with Cairn's own Playwright (recommended):\n" +
  "       cairn install-browsers\n" +
  "  2. Or drive your existing Google Chrome — no download:\n" +
  "       add --channel chrome   (or set BROWSER_CHANNEL=chrome)";

/**
 * True when an error (or raw stderr/stdout text) is a "browser binary is missing" situation —
 * either OUR own actionable error (matched by its stable name, so the message can evolve freely) or
 * Playwright's native signature in a child's output (launch error / executablePath error / the
 * "please run … playwright install" banner). Deliberately broad on the native side.
 */
export function isMissingBrowserError(err: unknown): boolean {
  if (err instanceof Error && err.name === "BrowsersNotInstalledError") return true;
  const msg =
    typeof err === "string" ? err : err instanceof Error ? err.message : err == null ? "" : String(err);
  if (!msg) return false;
  return (
    /Executable doesn't exist/i.test(msg) ||
    /please run the following command to download/i.test(msg) ||
    /playwright install/i.test(msg)
  );
}

/**
 * A clean, actionable Error for the missing-browser case — no stack trace is needed because the fix is
 * a copy-paste command. Prints cairn's Playwright version + the Chromium it expects (so the user can
 * see WHAT is missing) and the two exact fixes. The CLI prints `error.message` verbatim.
 */
export function missingBrowsersError(detail?: string): Error {
  const s = describeBrowserState();
  const lines = [
    "Playwright browsers are not installed.",
    "Cairn drives a Chromium build that ships separately from the npm package.",
    `  Cairn's Playwright: ${s.playwrightVersion}`,
  ];
  if (s.executablePath) {
    lines.push(`  Expected Chromium: ${s.executablePath} (${s.installed ? "present" : "missing"})`);
  }
  if (s.browsersPath) lines.push(`  PLAYWRIGHT_BROWSERS_PATH: ${s.browsersPath}`);
  lines.push("", INSTALL_BROWSERS_HINT);
  if (detail) lines.push("", `(${detail})`);
  const e = new Error(lines.join("\n"));
  e.name = "BrowsersNotInstalledError";
  return e;
}

/**
 * Is the bundled Chromium that `chromium.launch()` and the `@playwright/test` runner use by default
 * actually present on disk? `executablePath()` returns the computed path (and throws on some Playwright
 * versions when nothing is installed) — we treat both "throws" and "path absent" as not-installed.
 */
export function chromiumInstalled(): boolean {
  try {
    const p = chromium.executablePath();
    return Boolean(p) && existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Preflight gate: throw an actionable error if the bundled Chromium is missing.
 *
 * Skipped when a browser `channel` (system Chrome/Edge — e.g. for OAuth, or to coexist with a host
 * project's own Playwright) is configured, because that path drives the *system* browser, not the
 * bundled build, so the bundle's absence is moot. When a compatible Chromium is already in the cache
 * at the expected path, the check passes and that build is reused (no re-download).
 */
export function ensureBrowsersInstalled(opts: { channel?: string } = {}): void {
  if (opts.channel) return; // system browser — not the bundled Chromium
  if (!chromiumInstalled()) throw missingBrowsersError();
}
