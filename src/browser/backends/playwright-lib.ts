import { chromium, type Browser, type BrowserContext, type Download, type Locator, type Page, type Request, type Response } from "playwright";
import type { ApiTrafficRecorder } from "../api-traffic.js";
import type { BrowserBackend } from "../gateway.js";
import {
  CLICK_EFFECT_WINDOW_MS,
  DEAD_CLICK_RECHECK_MS,
  REQUEST_ANSWER_MS,
  WATCH_KEY,
  clickEffect,
  clickFailure,
  recordedPath,
  recordedUrl,
  watchScript,
  type PageSeen,
} from "../click-effect.js";
import { isMissingBrowserError, missingBrowsersError } from "../preflight.js";
import { navigateWithRecovery } from "../recovery.js";
import type {
  ActResult,
  Action,
  ClickEffect,
  ClickFailure,
  ElementRef,
  ElementState,
  HttpCredentials,
  Observation,
  ObserveOptions,
  RecordedRequest,
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
  /** HTTP Basic Auth for the context (environment-description feature). */
  httpCredentials?: HttpCredentials;
  /** #229: every response of the context — page loads and the requests clicks start — for the OpenAPI draft. */
  apiTraffic?: ApiTrafficRecorder;
}

/**
 * PRIMARY backend (ADR-0003): in-process Playwright. Owns storageState; captures ariaSnapshot+screenshot;
 * runs tests (Sprint 3). act() resolves ref→getByRole(role,{name}) based on the last observe().
 */
/** How long getState waits on a visible element that detaches mid-read (#213). */
const STATE_READ_TIMEOUT_MS = 2_000;

/** #224: how often a click that looks dead is read again, until DEAD_CLICK_RECHECK_MS. */
const RECHECK_STEP_MS = 100;
/** #224: how long the element observed a moment ago may take to be found for the page-side watch; when it is not
 * there, the click itself says why. */
const WATCH_INSTALL_MS = 500;
/** #224: how long reading the page-side watch may take. A page on its way to another document answers no script
 * until that document arrives, which may be never; the click is then unknown, not waited for. */
const WATCH_READ_MS = 500;
/** #224: a request the page sent this often (twice) within this long, outside any action, is a poll. */
const POLL_MEMORY_MS = 10_000;
/** Requests waited for while in flight, whatever their origin: they may render when they answer. */
const WAITED_REQUESTS = new Set(["document", "fetch", "xhr", "script"]);
/** …of which the page's own navigations and API calls are recorded — not scripts, images, fonts or beacons. */
const RECORDED_REQUESTS = new Set(["document", "fetch", "xhr"]);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** `p`, or `fallback` when it fails or takes longer than `ms`. */
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), pause(ms).then(() => fallback)]);

/** The page's ARIA snapshot, or undefined when it cannot be read (mid-navigation, page gone). */
const ariaOf = (page: Page): Promise<string | undefined> =>
  page.locator("body").ariaSnapshot({ timeout: STATE_READ_TIMEOUT_MS }).catch(() => undefined);

/**
 * Only the app's own origin is recorded: an analytics call on another host answering 204 to every click would make
 * every dead click look like a silent save. ponytail: an API on another origin (api.example.com for app.example.com)
 * is waited for but neither recorded nor counted; compare registrable domains instead if that matters.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** One endpoint, whatever its query: a poll often adds a timestamp. */
function requestKey(r: Request): string {
  try {
    const u = new URL(r.url());
    return `${r.method()} ${u.origin}${u.pathname}`;
  } catch {
    return `${r.method()} ${r.url()}`;
  }
}

/**
 * #229: one response, handed to the recorder; its body and its full headers are read only when the recorder asks (a JSON
 * answer, the API's own traffic). `allHeaders` because `headers()` leaves the cookies out. An answer a service worker
 * gave is the worker's, not the API's.
 */
function noteResponse(traffic: ApiTrafficRecorder, res: Response): void {
  try {
    if (res.fromServiceWorker()) return;
    const req = res.request();
    const headers = res.headers();
    const size = Number(headers["content-length"]);
    traffic.note({
      method: req.method(),
      url: res.url(),
      resourceType: req.resourceType(),
      status: res.status(),
      requestHeaders: req.headers(),
      allHeaders: async () => [...Object.entries(await req.allHeaders()), ...Object.entries(await res.allHeaders())],
      postData: req.postData(),
      responseContentType: headers["content-type"],
      ...(Number.isFinite(size) ? { responseSize: size } : {}),
      body: () => res.text(),
    });
  } catch {
    // a response of a page already gone: nothing to record
  }
}

export class PlaywrightLibBackend implements BrowserBackend {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private readonly refMap = new Map<string, { role: string; name?: string }>();
  private currentUrl = "";
  private lastStatus: number | undefined;
  private readonly consoleErrors: string[] = [];
  /** #224: the page's ARIA snapshot as last read — the "before" a watched click's changes are compared with. */
  private lastAria: string | undefined;
  /** #224: an action is running; requests sent meanwhile are its own, not the page's background. */
  private acting = false;
  /** #224: when each endpoint was requested outside any action, to tell a poll from a click's request. */
  private readonly background = new Map<string, number[]>();

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
      this.context = await this.browser.newContext({
        ...(this.opts.storageState ? { storageState: this.opts.storageState as unknown as PwStorageState } : {}),
        ...(this.opts.httpCredentials ? { httpCredentials: this.opts.httpCredentials } : {}),
      });
      const traffic = this.opts.apiTraffic;
      if (traffic) this.context.on("response", (res) => noteResponse(traffic, res));
    }
    if (!this.page) {
      this.page = await this.context.newPage();
      this.page.on("console", (m) => {
        if (m.type() === "error") this.consoleErrors.push(m.text());
      });
      this.page.on("pageerror", (e) => this.consoleErrors.push(e.message));
      this.page.on("request", (r) => this.noteBackground(r));
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
        const response = await this.page!.goto(url, { waitUntil: "domcontentloaded" });
        this.lastStatus = response?.status();
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
    this.lastAria = undefined;
    await this.ensurePage();
  }

  async observe(opts: ObserveOptions): Promise<Observation> {
    let status: number | undefined;
    if (opts.url) {
      this.lastStatus = undefined;
      await this.navigate(opts.url);
      status = this.lastStatus;
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
    this.lastAria = ariaSnapshot;
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
      ...(status !== undefined ? { status } : {}),
    };
  }

  async act(action: Action): Promise<ActResult> {
    this.acting = true;
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
      if (action.kind === "fill") {
        await locator.fill(action.value);
        return { ok: true, ref: action.ref };
      }
      if (action.watch === false) {
        await locator.click(action.timeoutMs === undefined ? undefined : { timeout: action.timeoutMs });
        return { ok: true, ref: action.ref };
      }
      const effect = await this.clickAndWatch(page, locator, target, action.timeoutMs);
      return { ok: true, ref: action.ref, outcome: effect.outcome, effect };
    } catch (e) {
      const ref = "ref" in action ? action.ref : undefined;
      const message = (e as Error).message;
      let cause = action.kind === "click" ? clickFailure(message) : undefined;
      if (cause === "not-found" && ref) cause = await this.hiddenOrGone(ref);
      return { ok: false, ref, error: message, ...(cause ? { outcome: cause } : {}) };
    } finally {
      this.acting = false;
    }
  }

  /** #224: nothing matched the element — it is still there, hidden (not-visible), or it is gone (not-found). */
  private async hiddenOrGone(ref: string): Promise<ClickFailure> {
    const target = this.refMap.get(ref);
    if (!target || !this.page) return "not-found";
    const hidden = await this.page
      .getByRole(target.role as PwRole, { ...(target.name ? { name: target.name, exact: true } : {}), includeHidden: true })
      .count()
      .catch(() => 0);
    return hidden > 0 ? "not-visible" : "not-found";
  }

  /** #224: a request started while no action runs; one endpoint seen twice within POLL_MEMORY_MS is a poll. */
  private noteBackground(r: Request): void {
    if (this.acting || !WAITED_REQUESTS.has(r.resourceType())) return;
    const now = Date.now();
    const key = requestKey(r);
    this.background.set(key, [...(this.background.get(key) ?? []).filter((t) => now - t < POLL_MEMORY_MS), now].slice(-2));
    if (this.background.size > 500) {
      for (const [k, times] of this.background) if (now - (times.at(-1) ?? 0) >= POLL_MEMORY_MS) this.background.delete(k);
    }
  }

  private isPoll(r: Request): boolean {
    const now = Date.now();
    return (this.background.get(requestKey(r)) ?? []).filter((t) => now - t < POLL_MEMORY_MS).length >= 2;
  }

  /**
   * #224: click, then record what changed. Before the click a page-side watch notes the element's state, the focus
   * and the scroll, and starts noting DOM changes; the backend listens for requests, a new tab and a download. After
   * the click it waits CLICK_EFFECT_WINDOW_MS, and for the requests in flight up to REQUEST_ANSWER_MS; it reads the
   * ARIA snapshot again only when the DOM changed. A click that looks dead is read again until DEAD_CLICK_RECHECK_MS.
   * Only the click itself can throw: once it is made, a read that fails makes the outcome unknown, not a failure.
   */
  private async clickAndWatch(page: Page, locator: Locator, target: { role: string; name?: string }, timeoutMs?: number): Promise<ClickEffect> {
    const from = page.url();
    const before = this.lastAria;
    const watched = await this.installWatch(page, locator);
    const traffic = this.watchTraffic(page, from);
    try {
      await locator.click(timeoutMs === undefined ? undefined : { timeout: timeoutMs });
      const clicked = Date.now();
      await pause(CLICK_EFFECT_WINDOW_MS);
      let after: string | undefined;
      for (;;) {
        // The answers render after they arrive: give them the same window before reading the page again.
        if (await traffic.settle(clicked + REQUEST_ANSWER_MS)) await pause(CLICK_EFFECT_WINDOW_MS);
        // A page whose next document is still on its way is not read: it would answer only once that document came.
        const navigating = traffic.navigating();
        const seen = watched && !navigating ? await within(page.evaluate(watchScript.read) as Promise<(PageSeen & { fresh: boolean }) | null>, WATCH_READ_MS, null) : null;
        const url = page.url(); // after the read: a document that arrived meanwhile counts as navigated
        if (seen?.fresh && url === from) after = await ariaOf(page);
        const effect = clickEffect({
          page: from,
          url,
          ...target,
          ...traffic.elsewhere(),
          ...(seen ? { seen } : {}),
          before,
          after,
          requests: traffic.recorded(),
          navigating,
        });
        // A link into another tab is given as long as a request: the browser can take more than a second to open it.
        if (effect.outcome !== "no-effect" || Date.now() - clicked >= (watched?.newTab ? REQUEST_ANSWER_MS : DEAD_CLICK_RECHECK_MS)) {
          if (after !== undefined) this.lastAria = after;
          return effect;
        }
        await pause(RECHECK_STEP_MS);
      }
    } finally {
      traffic.stop();
      if (!traffic.navigating()) await within(page.evaluate(watchScript.remove), WATCH_READ_MS, undefined); // a leaving page takes it along
    }
  }

  /**
   * Puts the page-side watch in place; undefined when it could not be (the element is not there, the page is
   * leaving). `newTab`: the element is in a link that opens its page in another tab (`target="_blank"` or a name).
   */
  private async installWatch(page: Page, locator: Locator): Promise<{ newTab: boolean } | undefined> {
    try {
      const newTab = await locator.evaluate(
        (el: unknown, key: string) => {
          (globalThis as unknown as Record<string, unknown>)[key] = { target: el };
          const link = (el as { closest(s: string): { target: string } | null }).closest("a[href][target], area[href][target]");
          return !!link && !["", "_self", "_parent", "_top"].includes(link.target.toLowerCase());
        },
        WATCH_KEY,
        { timeout: WATCH_INSTALL_MS },
      );
      await page.evaluate(watchScript.install);
      return { newTab };
    } catch {
      return undefined;
    }
  }

  /** The requests a click starts (polls left out), the tab it opens and the file it downloads; the tab is closed again. */
  private watchTraffic(page: Page, from: string) {
    const started: { r: Request; done: boolean; status?: number; recorded: boolean }[] = [];
    let tab: string | undefined;
    let download: string | undefined;
    const onRequest = (r: Request): void => {
      if (!WAITED_REQUESTS.has(r.resourceType()) || this.isPoll(r)) return;
      const entry: (typeof started)[number] = { r, done: false, recorded: RECORDED_REQUESTS.has(r.resourceType()) && sameOrigin(r.url(), from) };
      started.push(entry);
      void r
        .response()
        .then(
          (res) => {
            if (res) entry.status = res.status();
          },
          () => undefined,
        )
        .finally(() => {
          entry.done = true;
        });
    };
    const onPopup = (p: Page): void => {
      tab ??= recordedUrl(p.url());
      void p.close().catch(() => undefined);
    };
    const onDownload = (d: Download): void => {
      download ??= d.suggestedFilename();
      void d.cancel().catch(() => undefined);
    };
    page.on("request", onRequest);
    page.on("popup", onPopup);
    page.on("download", onDownload);
    return {
      /** Waits while a request is in flight, until `deadline`; true when there was one to wait for. */
      async settle(deadline: number): Promise<boolean> {
        if (started.every((e) => e.done)) return false;
        while (started.some((e) => !e.done) && Date.now() < deadline) await pause(50);
        return true;
      },
      elsewhere: (): { tab?: string; download?: string } => ({ ...(tab ? { tab } : {}), ...(download ? { download } : {}) }),
      recorded: (): RecordedRequest[] =>
        started
          .filter((e) => e.recorded)
          .map((e) => ({ method: e.r.method(), path: recordedPath(e.r.url()), ...(e.status !== undefined ? { status: e.status } : {}) })),
      navigating: (): boolean => started.some((e) => !e.done && e.r.isNavigationRequest() && e.r.frame() === page.mainFrame()),
      stop: (): void => {
        page.off("request", onRequest);
        page.off("popup", onPopup);
        page.off("download", onDownload);
      },
    };
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
    // #213: an element of another view (exploreStates) is not on the page, and isEnabled/isChecked wait for it
    // with Playwright's 30 s default - per element, minutes for a page of views. A hidden element is not read.
    const enabled = visible ? await loc.isEnabled({ timeout: STATE_READ_TIMEOUT_MS }).catch(() => false) : false;
    let checked: boolean | undefined;
    if (visible) {
      try {
        checked = await loc.isChecked({ timeout: STATE_READ_TIMEOUT_MS });
      } catch {
        checked = undefined; // not checkable, or gone since isVisible
      }
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
          ...(this.opts.httpCredentials ? { httpCredentials: this.opts.httpCredentials } : {}),
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
