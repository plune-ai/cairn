/**
 * First-class interactive session capture (L1-05).
 *
 * Opens a HEADED lib browser at the login URL, waits for the human to finish login
 * (Enter in the terminal, or a timed wait when stdin is not a TTY), then persists the
 * Playwright storageState (cookies + localStorage) via SessionStore. Shipped in dist/
 * so npm-installed users can capture a session WITHOUT the repo's scripts/.
 *
 * Reuses the lib backend (session() is lib-only, ADR-0003). NEVER prints secret values.
 */
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { makeGateway } from "../browser/index.js";
import type { BrowserGateway } from "../browser/index.js";
import { SessionStore } from "./index.js";

export interface CaptureSessionOptions {
  /** Login URL to open in the headed browser. */
  url: string;
  /** Session name (file = <dir>/<name>.storageState.json). Default: slug of the URL host. */
  name?: string;
  /** Browser channel (e.g. "chrome") — helps bypass OAuth automation detection. */
  channel?: string;
  /** Sessions directory. Default ".auth". */
  dir?: string;
  /** Seconds to wait for login when stdin is NOT a TTY (no Enter possible). Default 150. */
  waitSeconds?: number;
  /** Injected gateway (tests). Default: a headed lib gateway. */
  gateway?: BrowserGateway;
  /** Completion signal. Default: press Enter (TTY) or a timed wait (non-TTY). */
  waitForLogin?: () => Promise<void>;
  /** Progress sink. MUST NOT receive secret values (this function never passes any). */
  onLog?: (msg: string) => void;
}

export interface CaptureSessionResult {
  /** Resolved session name. */
  name: string;
  /** Absolute path of the saved storageState file. */
  path: string;
}

/** Slug a URL into a safe default session name (host without punctuation). */
function defaultName(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-");
  } catch {
    return "default";
  }
}

/** Default completion signal: press Enter (TTY) or wait `seconds` (non-TTY). */
function makeDefaultWaitForLogin(
  seconds: number,
  url: string,
  log: (m: string) => void,
): () => Promise<void> {
  return async (): Promise<void> => {
    if (stdin.isTTY) {
      // Lazy import: keep readline out of library-only code paths.
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        await rl.question(
          "Log in via the browser window. Once you are INSIDE the app — press Enter here… ",
        );
      } finally {
        rl.close();
      }
    } else {
      log(`stdin is not interactive — saving automatically in ${seconds}s. Log in now at ${url}.`);
      await new Promise((r) => setTimeout(r, seconds * 1000));
    }
  };
}

/**
 * Capture a browser session interactively and persist it via SessionStore.
 * Returns the resolved name + absolute file path. The gateway is always closed.
 */
export async function captureSession(opts: CaptureSessionOptions): Promise<CaptureSessionResult> {
  const name = opts.name ?? defaultName(opts.url);
  const log = opts.onLog ?? ((): void => undefined);
  const ownsGateway = !opts.gateway;
  let gateway =
    opts.gateway ?? makeGateway({ backend: "lib", headless: false, channel: opts.channel });
  const waitForLogin =
    opts.waitForLogin ?? makeDefaultWaitForLogin(opts.waitSeconds ?? 150, opts.url, log);

  try {
    log(`Opening ${opts.url} — a browser window will appear for you to log in.`);
    try {
      await gateway.observe({ url: opts.url });
    } catch (e) {
      // Channel browser (e.g. chrome) not installed → fall back to the bundled browser,
      // matching the original save-session behavior. Only for a gateway we created ourselves.
      if (ownsGateway && opts.channel) {
        log(`Channel "${opts.channel}" unavailable — falling back to the bundled browser.`);
        await gateway.close();
        gateway = makeGateway({ backend: "lib", headless: false });
        await gateway.observe({ url: opts.url });
      } else {
        throw e;
      }
    }
    await waitForLogin();
    const state = await gateway.session().save();
    const store = new SessionStore(resolve(opts.dir ?? ".auth"));
    await store.save(name, state);
    const path = store.pathFor(name);
    log(`✓ Session "${name}" saved → ${path}`);
    return { name, path };
  } finally {
    await gateway.close();
  }
}
