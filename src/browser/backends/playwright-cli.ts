import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserBackend } from "../gateway.js";
import type { ActResult, Action, Observation, ObserveOptions } from "../types.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Resolve the `@playwright/cli` bin LAZILY (on first command), not at module load.
 *
 * `@playwright/cli` is an OPTIONAL peer dependency: it is the experimental SECONDARY backend
 * (ADR-0003) and — critically — it drags `playwright-core@…-alpha`, the split that broke browser
 * installs (0.3.3). Cairn now ships a single stable `playwright-core` and does NOT install
 * `@playwright/cli` by default, so resolving it at import time would crash EVERY gateway import
 * (incl. the default `lib` backend). Resolving on first use keeps the import safe and turns a missing
 * package into one actionable error — only for users who actually opt into `--backend cli`.
 */
function resolveCliJs(): string {
  try {
    return join(dirname(require.resolve("@playwright/cli/package.json")), "playwright-cli.js");
  } catch {
    throw new Error(
      "The 'cli' browser backend needs the optional @playwright/cli package, which is not installed.\n" +
        "Enable it:  npm install -D @playwright/cli\n" +
        "Or use the default in-process backend (no extra install):  --backend lib (BROWSER_BACKEND=lib).",
    );
  }
}

export interface PlaywrightCliOptions {
  session?: string;
}

/**
 * SECONDARY backend (ADR-0003): a wrapper over `@playwright/cli` (stateful MCP-CLI, headless by default).
 * Token-efficient observe/act. Does NOT own session/runTests — those come from lib (hence not implemented here).
 *
 * Spike S3 limitations: the `file:` protocol is blocked (an http origin is required); each command is a separate
 * node→daemon process; the snapshot yields native refs `[ref=eN]`, which parseAriaSnapshot uses directly.
 */
export class PlaywrightCliBackend implements BrowserBackend {
  private readonly sessionName: string;
  private opened = false;

  constructor(opts: PlaywrightCliOptions = {}) {
    this.sessionName = opts.session ?? "lex-bot";
  }

  private async run(args: string[]): Promise<string> {
    const cliJs = resolveCliJs();
    const { stdout } = await execFileAsync(process.execPath, [cliJs, `-s=${this.sessionName}`, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  private async ensureUrl(url?: string): Promise<void> {
    if (url) {
      if (this.opened) await this.run(["goto", url]);
      else {
        await this.run(["open", url]);
        this.opened = true;
      }
    } else if (!this.opened) {
      await this.run(["open"]);
      this.opened = true;
    }
  }

  async observe(opts: ObserveOptions): Promise<Observation> {
    await this.ensureUrl(opts.url);
    const ariaSnapshot = (await this.run(["--raw", "snapshot"])).trim();

    const dir = await mkdtemp(join(tmpdir(), "qa-cli-shot-"));
    const shot = join(dir, "shot.png");
    let screenshotB64 = "";
    try {
      await this.run(["screenshot", `--filename=${shot}`]);
      screenshotB64 = (await readFile(shot)).toString("base64");
      await unlink(shot).catch(() => undefined);
    } catch {
      // the screenshot is not critical for observe
    }

    const url = opts.url ?? (await this.run(["--raw", "eval", "location.href"])).trim();
    return { url, screenshotB64, ariaSnapshot, capturedBy: "cli" };
  }

  async act(action: Action): Promise<ActResult> {
    try {
      if (action.kind === "navigate") {
        await this.ensureUrl(action.url);
        return { ok: true };
      }
      if (action.kind === "click") await this.run(["click", action.ref]);
      else await this.run(["fill", action.ref, action.value]);
      return { ok: true, ref: action.ref };
    } catch (e) {
      const ref = "ref" in action ? action.ref : undefined;
      return { ok: false, ref, error: (e as Error).message };
    }
  }

  async close(): Promise<void> {
    if (this.opened) {
      await this.run(["close"]).catch(() => undefined);
      this.opened = false;
    }
  }
}
