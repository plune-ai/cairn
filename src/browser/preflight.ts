import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Browser preflight (onboarding guardrail).
 *
 * `npm install @plune-ai/cairn` pulls the `playwright` *library* but NOT the browser
 * *binaries* — those are a separate `npx playwright install` download. On a fresh machine
 * `chromium.launch()` (observe/design) and the `@playwright/test` runner (automate --validate)
 * therefore die with a raw "Executable doesn't exist …" deep inside the run, which surfaces to
 * the user as a misleading "0% green · N failed" with the real cause buried in a child's stderr.
 *
 * This module turns that into one clear, actionable message — and lets callers fail fast BEFORE
 * spending any LLM calls. Two layers cooperate (defense in depth):
 *   1. {@link ensureBrowsersInstalled} — a cheap up-front check (is the bundled Chromium on disk?).
 *   2. {@link isMissingBrowserError} — a string/error detector used as a backstop where a launch
 *      actually fails (e.g. the headless-shell binary is missing while full Chromium is present).
 */

/** The single source of truth for the install command we point users at. */
export const INSTALL_BROWSERS_HINT =
  "Playwright browsers are not installed.\n" +
  "Cairn drives a Chromium build that ships separately from the npm package.\n" +
  "Install it once, then re-run your command:\n\n" +
  "    npx playwright install chromium\n";

/**
 * True when an error (or raw stderr/stdout text) is Playwright's "browser binary is missing"
 * signature. Deliberately broad: matches the launch error, the executablePath() error, and the
 * "please run … playwright install" banner — so it catches both the full-Chromium and the
 * headless-shell variants regardless of which surface raised it.
 */
export function isMissingBrowserError(err: unknown): boolean {
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
 * A clean, actionable Error for the missing-browser case — no stack trace is needed because the
 * fix is a copy-paste command. The CLI prints `error.message` verbatim (see cli/index.ts).
 */
export function missingBrowsersError(detail?: string): Error {
  const e = new Error(detail ? `${INSTALL_BROWSERS_HINT}\n(${detail})` : INSTALL_BROWSERS_HINT);
  e.name = "BrowsersNotInstalledError";
  return e;
}

/**
 * Is the bundled Chromium that `chromium.launch()` and the `@playwright/test` runner use by
 * default actually present on disk? `executablePath()` returns the computed path (and throws on
 * some Playwright versions when nothing is installed) — we treat both "throws" and "path absent"
 * as not-installed.
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
 * Skipped when a browser `channel` (system Chrome/Edge — e.g. for OAuth) is configured, because
 * that path drives the *system* browser, not the bundled build, so the bundle's absence is moot.
 */
export function ensureBrowsersInstalled(opts: { channel?: string } = {}): void {
  if (opts.channel) return; // system browser — not the bundled Chromium
  if (!chromiumInstalled()) throw missingBrowsersError();
}
