import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

/**
 * Browser provisioning + diagnostics (0.3.3).
 *
 * The whole point: every browser action resolves through CAIRN'S OWN `playwright` package — the single
 * stable `playwright-core` it launches at runtime — so the Chromium revision cairn INSTALLS always
 * matches the one it LAUNCHES, regardless of any other Playwright in the host project. (The 0.3.2 bug
 * was a second, alpha `playwright-core` whose expected revision a normal `playwright install` never
 * provided, and a generic `npx playwright install` hint that resolved to the wrong Playwright.)
 */

const require = createRequire(import.meta.url);

export interface BrowserState {
  /** Cairn's own Playwright version — the build it launches AND installs against (single source). */
  playwrightVersion: string;
  /** Bundled-Chromium executable path Playwright computes (its parent dir encodes the revision). */
  executablePath?: string;
  /** Whether that executable is actually present on disk. */
  installed: boolean;
  /** PLAYWRIGHT_BROWSERS_PATH override, if set — where Playwright looks for / installs builds. */
  browsersPath?: string;
}

/** Resolve the version of the `playwright` package cairn itself drives. */
function ownPlaywrightVersion(): string {
  try {
    const pkgPath = require.resolve("playwright/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Snapshot of cairn's browser setup — feeds both the missing-browser error and `cairn doctor`. */
export function describeBrowserState(): BrowserState {
  let executablePath: string | undefined;
  let installed = false;
  try {
    const p = chromium.executablePath(); // honours PLAYWRIGHT_BROWSERS_PATH internally
    executablePath = p || undefined;
    installed = Boolean(p) && existsSync(p);
  } catch {
    installed = false; // some Playwright versions throw here when nothing is installed
  }
  return {
    playwrightVersion: ownPlaywrightVersion(),
    executablePath,
    installed,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || undefined,
  };
}

export interface InstallBrowsersResult {
  ok: boolean;
  playwrightVersion: string;
}

/**
 * Install Chromium using cairn's OWN Playwright CLI (`node <playwright>/cli.js install chromium`),
 * resolved from cairn's package dir — so the revision matches what cairn launches, never the host
 * project's Playwright. Streams the installer's own progress to the inherited stdio.
 */
export async function installBrowsers(
  opts: { onLog?: (s: string) => void } = {},
): Promise<InstallBrowsersResult> {
  const playwrightVersion = ownPlaywrightVersion();
  const log = opts.onLog ?? ((): void => undefined);
  let cliJs: string;
  try {
    cliJs = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  } catch {
    log("Could not resolve Cairn's own Playwright — is the install complete?\n");
    return { ok: false, playwrightVersion };
  }
  log(`Installing Chromium with Cairn's Playwright (${playwrightVersion})…\n`);
  return await new Promise<InstallBrowsersResult>((resolvePromise) => {
    const child = spawn(process.execPath, [cliJs, "install", "chromium"], { stdio: "inherit" });
    child.on("error", () => resolvePromise({ ok: false, playwrightVersion }));
    child.on("close", (code) => resolvePromise({ ok: code === 0, playwrightVersion }));
  });
}

/** Human-readable diagnostics for `cairn doctor` — pure (returns lines) so it is trivially testable. */
export function doctorReport(): string[] {
  const s = describeBrowserState();
  const lines = [
    "Cairn browser diagnostics",
    `  Playwright (the build Cairn launches AND installs against): ${s.playwrightVersion}`,
  ];
  if (s.executablePath) lines.push(`  Bundled Chromium: ${s.executablePath}`);
  lines.push(`  Bundled Chromium present: ${s.installed ? "yes" : "no"}`);
  if (s.browsersPath) lines.push(`  PLAYWRIGHT_BROWSERS_PATH: ${s.browsersPath}`);
  lines.push("");
  if (s.installed) {
    lines.push("✓ Ready — `cairn explore` / `cairn automate --validate` can launch the bundled Chromium.");
  } else {
    lines.push("✗ The bundled Chromium is missing. Fix it one of two ways:");
    lines.push("    cairn install-browsers      # download the matching Chromium (Cairn's own Playwright)");
    lines.push("    …or add --channel chrome    # drive your installed Google Chrome instead (no download)");
  }
  return lines;
}
