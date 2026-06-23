import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserBackend } from "../gateway.js";
import { isMissingBrowserError, missingBrowsersError } from "../preflight.js";
import { navigateWithRecovery } from "../recovery.js";
import type {
  ActResult,
  Action,
  ElementRef,
  ElementState,
  Observation,
  ObserveOptions,
  SessionApi,
  StorageState,
  TestRunReport,
  VerifiedElement,
} from "../types.js";
import { parseAriaSnapshot } from "../../observe/parse-aria.js";

/** Canonical Playwright storageState type (bridge between our StorageState and the runtime). */
type PwStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type PwRole = Parameters<Page["getByRole"]>[0];

export interface PlaywrightLibOptions {
  headless?: boolean;
  storageState?: StorageState;
  /** Browser channel (chrome/msedge) — for bypassing automation detection (e.g. Google OAuth). */
  channel?: string;
}

/**
 * PRIMARY backend (ADR-0003): in-process Playwright. Owns storageState; captures ariaSnapshot+screenshot;
 * runs tests (Sprint 3). act() resolves ref→getByRole(role,{name}) based on the last observe().
 */
export class PlaywrightLibBackend implements BrowserBackend {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private readonly refMap = new Map<string, { role: string; name?: string }>();
  private currentUrl = "";
  private readonly consoleErrors: string[] = [];

  constructor(private readonly opts: PlaywrightLibOptions = {}) {}

  private async launch(): Promise<Browser> {
    try {
      return await chromium.launch({
        headless: this.opts.headless ?? true,
        channel: this.opts.channel,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (e) {
      // Backstop for observe/design: translate Playwright's raw "Executable doesn't exist …" into
      // the one actionable message. Covers the case the up-front preflight can't (e.g. the
      // headless-shell binary missing while full Chromium is present). Other launch errors pass through.
      if (isMissingBrowserError(e)) throw missingBrowsersError();
      throw e;
    }
  }

  private async ensurePage(): Promise<Page> {
    this.browser ??= await this.launch();
    if (!this.context) {
      this.context = await this.browser.newContext(
        this.opts.storageState
          ? { storageState: this.opts.storageState as unknown as PwStorageState }
          : {},
      );
    }
    if (!this.page) {
      this.page = await this.context.newPage();
      this.page.on("console", (m) => {
        if (m.type() === "error") this.consoleErrors.push(m.text());
      });
      this.page.on("pageerror", (e) => this.consoleErrors.push(e.message));
    }
    return this.page;
  }

  /**
   * Navigate with tiered transient-error recovery (#90): a transient SPA nav error (e.g. ERR_ABORTED)
   * gets a cheap settle + retry on the SAME page — grounded state (refMap) stays valid — and only a
   * fatal / retry-exhausted error escalates to the expensive {@link recreatePage}.
   */
  private async navigate(url: string): Promise<void> {
    await this.ensurePage();
    await navigateWithRecovery({
      goto: async () => {
        await this.page!.goto(url, { waitUntil: "domcontentloaded" });
      },
      settle: async () => {
        await this.page!.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        await this.page!.waitForTimeout(300);
      },
      recreate: async () => {
        await this.recreatePage();
      },
    });
  }

  /**
   * EXPENSIVE recovery: drop the current page and open a fresh one on the SAME context — auth /
   * storageState survive, but the grounded refMap is cleared, so the caller must re-observe. Reached
   * only for fatal / retry-exhausted navigation (transient errors retry the same page instead).
   */
  private async recreatePage(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    this.page = undefined;
    this.refMap.clear();
    await this.ensurePage();
  }

  async observe(opts: ObserveOptions): Promise<Observation> {
    if (opts.url) {
      await this.navigate(opts.url);
      this.currentUrl = opts.url;
    }
    const page = await this.ensurePage(); // after navigate: picks up a recreated page if recovery ran
    // #102: after a SPA link click the router updates location.href asynchronously — wait (briefly,
    // best-effort) for it to differ from the previous URL before snapshotting, so the crawl sees the
    // new page instead of the stale one.
    if (opts.waitForUrlChange) {
      // Poll the live frame URL (Node-side, no browser eval) until the SPA router updates it, ~3s cap.
      for (let i = 0; i < 20 && page.url() === opts.waitForUrlChange; i++) {
        await page.waitForTimeout(150);
      }
    }
    // SPA hydration: content loads asynchronously AFTER domcontentloaded.
    // Without this, the snapshot = only the static shell (nav), without the real page content.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    // #102: when not navigating explicitly (e.g. after a click), the live page.url() is the source of
    // truth — the SPA may have client-routed — so sync currentUrl instead of returning the stale value.
    if (!opts.url) this.currentUrl = page.url();
    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    const buf = await page.screenshot({ fullPage: opts.fullPage ?? false });

    this.refMap.clear();
    for (const el of parseAriaSnapshot(ariaSnapshot)) {
      this.refMap.set(el.ref, { role: el.role, name: el.name });
    }

    return {
      url: this.currentUrl || page.url(),
      screenshotB64: buf.toString("base64"),
      ariaSnapshot,
      capturedBy: "lib",
      consoleErrors: [...this.consoleErrors],
    };
  }

  async act(action: Action): Promise<ActResult> {
    try {
      const page = await this.ensurePage();
      if (action.kind === "navigate") {
        await this.navigate(action.url);
        this.currentUrl = action.url;
        return { ok: true };
      }
      const target = this.refMap.get(action.ref);
      if (!target) {
        return { ok: false, ref: action.ref, error: `Unknown ref '${action.ref}' — call observe() first.` };
      }
      const locator = page
        .getByRole(target.role as PwRole, target.name ? { name: target.name, exact: true } : {})
        .first();
      if (action.kind === "click") await locator.click();
      else await locator.fill(action.value);
      return { ok: true, ref: action.ref };
    } catch (e) {
      const ref = "ref" in action ? action.ref : undefined;
      return { ok: false, ref, error: (e as Error).message };
    }
  }

  async verify(elements: ElementRef[]): Promise<VerifiedElement[]> {
    const page = await this.ensurePage();
    const out: VerifiedElement[] = [];
    for (const el of elements) {
      let count = -1;
      try {
        count = await page
          .getByRole(el.role as PwRole, el.name ? { name: el.name, exact: true } : {})
          .count();
      } catch {
        count = -1;
      }
      out.push({ ...el, count, verified: count === 1 });
    }
    return out;
  }

  async getState(el: ElementRef): Promise<ElementState> {
    const page = await this.ensurePage();
    const loc = page
      .getByRole(el.role as PwRole, el.name ? { name: el.name, exact: true } : {})
      .first();
    const visible = await loc.isVisible().catch(() => false);
    const enabled = visible ? await loc.isEnabled().catch(() => false) : false;
    let checked: boolean | undefined;
    try {
      checked = await loc.isChecked();
    } catch {
      checked = undefined; // not checkable
    }
    return { visible, enabled, checked };
  }

  session(): SessionApi {
    return {
      load: async (state: StorageState) => {
        await this.page?.close().catch(() => undefined);
        await this.context?.close().catch(() => undefined);
        this.page = undefined;
        this.browser ??= await this.launch();
        this.context = await this.browser.newContext({
          storageState: state as unknown as PwStorageState,
        });
        this.page = await this.context.newPage();
      },
      save: async (): Promise<StorageState> => {
        if (!this.context) {
          throw new Error("No active context — call observe()/navigate() first.");
        }
        return (await this.context.storageState()) as unknown as StorageState;
      },
    };
  }

  async runTests(): Promise<TestRunReport> {
    throw new Error("runTests is implemented in Sprint 3.");
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }
}
