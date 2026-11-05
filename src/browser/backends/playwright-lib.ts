import { chromium, type Browser, type BrowserContext, type BrowserServer, type Download, type Locator, type Page, type Request } from "playwright";
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
  OverlayScope,
  Observation,
  ObserveOptions,
  RecordedRequest,
  SessionApi,
  StorageState,
  TestRunReport,
  VerifiedElement,
  BlockedRequest,
  WriteGuard,
} from "../types.js";
import { overlayKey, parseAriaSnapshot } from "../../observe/parse-aria.js";

/** Canonical Playwright storageState type (bridge between our StorageState and the runtime). */
type PwStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type PwRole = Parameters<Page["getByRole"]>[0];

/** #225: what act() needs of an observed element. */
interface Target {
  role: string;
  name?: string;
  scope?: OverlayScope;
  underOverlay?: true;
}

/**
 * #225: the locator of an element — inside its dialog when it has one, so a same-named element on the page is not it.
 * `includeHidden` looks for what is not shown (to tell a hidden element from a gone one).
 */
function locate(page: Page, t: { role: string; name?: string; scope?: OverlayScope }, includeHidden = false): Locator {
  const own = { ...(t.name ? { name: t.name, exact: true } : {}), ...(includeHidden ? { includeHidden: true } : {}) };
  const root = t.scope
    ? page.getByRole(t.scope.role as PwRole, t.scope.name ? { name: t.scope.name, exact: true } : {})
    : page;
  return root.getByRole(t.role as PwRole, own);
}

export interface PlaywrightLibOptions {
  headless?: boolean;
  storageState?: StorageState;
  /** Browser channel (chrome/msedge) — for bypassing automation detection (e.g. Google OAuth). */
  channel?: string;
  /** HTTP Basic Auth for the context (environment-description feature). */
  httpCredentials?: HttpCredentials;
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

/** #225 review 3: the methods the write guard lets through: by HTTP's own rule they read and change nothing. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The Blink features every browser of this backend runs without. */
const BLINK_OFF = "AutomationControlled";
/**
 * #225 review 4: the one API seen sending where the browser's own Fetch interception does not look (full Chromium and
 * Chrome; the headless shell has none): it does not exist in the browser that presses.
 */
const SENDS_PAST_FETCH = "BackgroundFetch";

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** `p`, or `fallback` when it fails or takes longer than `ms`. */
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), pause(ms).then(() => fallback)]);

/** The page's ARIA snapshot, or undefined when it cannot be read (mid-navigation, page gone). */
const ariaOf = (page: Page): Promise<string | undefined> =>
  page.locator("body").ariaSnapshot({ timeout: STATE_READ_TIMEOUT_MS }).catch(() => undefined);

/** #225 review 4: runs in the crawler's page: its tab's sessionStorage, which no storageState holds. */
const readTabStorage = (): { origin: string; items: [string, string][] } => {
  const g = globalThis as unknown as { location: { origin: string }; sessionStorage: Record<string, string> };
  return { origin: g.location.origin, items: Object.entries(g.sessionStorage) };
};

/** #225 review 4: runs before a page's scripts in the pressing context: the session is there when the app looks for it. */
const seedTabStorage = (tab: { origin: string; items: [string, string][] }): void => {
  const g = globalThis as unknown as { location: { origin: string }; sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } };
  if (g.location.origin !== tab.origin) return;
  try {
    for (const [k, v] of tab.items) if (g.sessionStorage.getItem(k) === null) g.sessionStorage.setItem(k, v);
  } catch {
    // a sandboxed frame has no storage to fill
  }
};

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

export class PlaywrightLibBackend implements BrowserBackend {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private readonly refMap = new Map<string, Target>();
  /** #225: the dialogs of the last snapshot that the DOM says are not modal (`role|name`). */
  private nonModal = new Set<string>();
  private currentUrl = "";
  private lastStatus: number | undefined;
  private readonly consoleErrors: string[] = [];
  /** #224: the page's ARIA snapshot as last read — the "before" a watched click's changes are compared with. */
  private lastAria: string | undefined;
  /** #224: an action is running; requests sent meanwhile are its own, not the page's background. */
  private acting = false;
  /** #224: when each endpoint was requested outside any action, to tell a poll from a click's request. */
  private readonly background = new Map<string, number[]>();
  /**
   * #225 review 4: while the write guard is on, a second backend in a browser process of its own, which takes every
   * observe, act, verify and getState. This one's context, page and fields are not touched until it is gone.
   */
  private pressing?: PlaywrightLibBackend;
  /** #225 review 4: on a pressing backend, the process of its browser, to kill. */
  private server?: BrowserServer;
  /** #225 review 3: the element (or key) pressed last, named beside each request the guard stops. */
  private lastPressed?: { role: string; name?: string };

  constructor(private readonly opts: PlaywrightLibOptions = {}) {}

  private launchOptions(blinkOff: string) {
    return { headless: this.opts.headless ?? true, channel: this.opts.channel, args: [`--disable-blink-features=${blinkOff}`] };
  }

  private async launch(): Promise<Browser> {
    try {
      return await chromium.launch(this.launchOptions(BLINK_OFF));
    } catch (e) {
      // Backstop for observe/design: translate Playwright's raw "Executable doesn't exist …" into
      // the one actionable message. Covers the case the up-front preflight can't (e.g. the
      // headless-shell binary missing while full Chromium is present). Other launch errors pass through.
      if (isMissingBrowserError(e)) throw missingBrowsersError();
      throw e;
    }
  }

  /** A context with this backend's options: the crawler's, and the one the write guard presses in. */
  private newContext(storageState?: PwStorageState): Promise<BrowserContext> {
    return this.browser!.newContext({
      ...(storageState ? { storageState } : {}),
      ...(this.opts.httpCredentials ? { httpCredentials: this.opts.httpCredentials } : {}),
    });
  }

  private async ensurePage(): Promise<Page> {
    this.browser ??= await this.launch();
    this.context ??= await this.newContext(this.opts.storageState as unknown as PwStorageState | undefined);
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
    if (this.pressing) return this.pressing.observe(opts);
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

    this.nonModal = await this.nonModalDialogs(page, ariaSnapshot);
    this.refMap.clear();
    for (const el of parseAriaSnapshot(ariaSnapshot, { nonModal: this.nonModal })) {
      this.refMap.set(el.ref, { role: el.role, name: el.name, ...(el.scope ? { scope: el.scope } : {}), ...(el.underOverlay ? { underOverlay: true as const } : {}) });
    }

    return {
      url: this.currentUrl || page.url(),
      screenshotB64: buf.toString("base64"),
      ariaSnapshot,
      capturedBy: "lib",
      consoleErrors: [...this.consoleErrors],
      nonModal: [...this.nonModal],
      ...(status !== undefined ? { status } : {}),
    };
  }

  /**
   * #225: which dialogs of the snapshot are not modal. The ARIA snapshot does not say: the DOM does (`aria-modal`, or
   * a native `<dialog>` opened with showModal()). A page whose DOM cannot be read keeps every dialog modal.
   */
  private async nonModalDialogs(page: Page, aria: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const el of parseAriaSnapshot(aria)) {
      if (el.role !== "dialog" && el.role !== "alertdialog") continue;
      const loc = locate(page, { role: el.role, name: el.name }).first();
      const modal = await loc
        .evaluate(
          (node: unknown) => {
            const n = node as { matches(s: string): boolean; getAttribute(a: string): string | null };
            return n.getAttribute("aria-modal") === "true" || n.matches(":modal") || n.getAttribute("role") === "alertdialog";
          },
          undefined,
          { timeout: 1_000 },
        )
        .catch(() => true);
      if (!modal) out.add(overlayKey(el.role, el.name));
    }
    return out;
  }

  async act(action: Action): Promise<ActResult> {
    if (this.pressing) return this.pressing.act(action);
    this.acting = true;
    try {
      const page = await this.ensurePage();
      if (action.kind === "navigate") {
        await this.navigate(action.url);
        this.currentUrl = action.url;
        return { ok: true };
      }
      if (action.kind === "press") {
        this.lastPressed = { role: "key", name: action.key };
        await page.keyboard.press(action.key);
        return { ok: true };
      }
      if (action.kind === "click-outside") {
        const point = await this.safePointOutside(page, action.scope);
        if (!point) return { ok: false, error: "no point outside the overlay that is safe to click; click outside not tried" };
        this.lastPressed = { role: "click-outside", ...(action.scope.name !== undefined ? { name: action.scope.name } : {}) };
        await page.mouse.click(point.x, point.y);
        return { ok: true };
      }
      const target = this.refMap.get(action.ref);
      if (!target) {
        return { ok: false, ref: action.ref, error: `Unknown ref '${action.ref}' — call observe() first.` };
      }
      if (target.underOverlay) {
        // #225: a modal overlay is open and this element lies under it: never touched, the click would only time out.
        return {
          ok: false,
          ref: action.ref,
          error: `${target.role}${target.name ? ` "${target.name}"` : ""} lies under an open modal overlay; close it first.`,
          outcome: "under-overlay",
        };
      }
      const locator = locate(page, target).first();
      if (action.kind === "fill") {
        await locator.fill(action.value);
        return { ok: true, ref: action.ref };
      }
      this.lastPressed = { role: target.role, ...(target.name !== undefined ? { name: target.name } : {}) };
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

  /**
   * #225 review: a point to click "outside" the overlay `scope`. A blind corner click pressed a fixed «Sign out» link,
   * so each candidate point is checked first: what `elementFromPoint` finds there must lie outside the overlay and be
   * nothing a click acts on — no link, button, field, label, summary, element with a click role, a tabindex, an inline
   * handler, or a pointer cursor. Corners first, then the edges, then a grid; undefined when none is safe.
   */
  private async safePointOutside(page: Page, scope: OverlayScope): Promise<{ x: number; y: number } | undefined> {
    const overlay = locate(page, scope).first();
    const point = await overlay
      .evaluate(
        (node: unknown) => {
          type El = { contains(o: unknown): boolean; closest(s: string): unknown; parentElement: El | null };
          const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): El | null } }).document;
          const win = globalThis as unknown as { innerWidth: number; innerHeight: number; getComputedStyle(e: unknown): { cursor: string } };
          const overlayEl = node as El;
          const ACTS =
            "a[href],button,input,select,textarea,label,summary,option,[contenteditable=''],[contenteditable='true'],[onclick],[tabindex]:not([tabindex='-1'])," +
            ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "gridcell", "combobox", "textbox", "slider", "spinbutton", "searchbox"]
              .map((r) => `[role='${r}']`)
              .join(",");
          const w = win.innerWidth;
          const h = win.innerHeight;
          const xs = [2, w - 3, Math.round(w / 2)];
          const ys = [2, h - 3, Math.round(h / 2)];
          const points: [number, number][] = [];
          for (const y of [ys[0]!, ys[1]!]) for (const x of [xs[0]!, xs[1]!]) points.push([x, y]);
          for (const [x, y] of [[xs[2]!, ys[0]!], [xs[2]!, ys[1]!], [xs[0]!, ys[2]!], [xs[1]!, ys[2]!]] as [number, number][]) points.push([x, y]);
          for (let gy = 1; gy < 8; gy++) for (let gx = 1; gx < 8; gx++) points.push([Math.round((w * gx) / 8), Math.round((h * gy) / 8)]);
          for (const [x, y] of points) {
            const el = doc.elementFromPoint(x, y);
            if (!el || overlayEl.contains(el) || el.closest(ACTS)) continue;
            let pointer = false;
            for (let e: El | null = el; e && !pointer; e = e.parentElement) {
              if (e === overlayEl) break;
              pointer = win.getComputedStyle(e).cursor === "pointer";
            }
            if (!pointer) return { x, y };
          }
          return null;
        },
        undefined,
        { timeout: STATE_READ_TIMEOUT_MS },
      )
      .catch(() => null);
    return point ?? undefined;
  }

  /** #224: nothing matched the element — it is still there, hidden (not-visible), or it is gone (not-found). */
  private async hiddenOrGone(ref: string): Promise<ClickFailure> {
    const target = this.refMap.get(ref);
    if (!target || !this.page) return "not-found";
    const hidden = await locate(this.page, target, true)
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
  private async clickAndWatch(page: Page, locator: Locator, target: Target, timeoutMs?: number): Promise<ClickEffect> {
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
    if (this.pressing) return this.pressing.verify(elements);
    const page = await this.ensurePage();
    const out: VerifiedElement[] = [];
    for (const el of elements) {
      let count = -1;
      try {
        count = await locate(page, el).count();
      } catch {
        count = -1;
      }
      out.push({ ...el, count, verified: count === 1 });
    }
    return out;
  }

  async getState(el: ElementRef): Promise<ElementState> {
    if (this.pressing) return this.pressing.getState(el);
    const page = await this.ensurePage();
    const loc = locate(page, el).first();
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
    // #225 review: what the element says it opens; only such an element is pressed to look for an overlay.
    // #225 review 2: and whether pressing it submits a form (a submit button inside a form), which is never pressed.
    const read = visible
      ? await loc
          .evaluate(
            (node: unknown) => {
              const n = node as { getAttribute(a: string): string | null; tagName: string; type?: string; form?: unknown };
              const hasPopup = n.getAttribute("aria-haspopup");
              const expanded = n.getAttribute("aria-expanded");
              const controls = n.getAttribute("aria-controls");
              const tag = n.tagName.toLowerCase();
              // `type` is the property: a <button> with no (or an unknown) type attribute reads "submit".
              const submitter = (tag === "button" && n.type === "submit") || (tag === "input" && (n.type === "submit" || n.type === "image"));
              return {
                popup: {
                  ...(hasPopup !== null && hasPopup !== "false" ? { hasPopup: hasPopup || "true" } : {}),
                  ...(expanded === "true" || expanded === "false" ? { expanded: expanded === "true" } : {}),
                  ...(controls ? { controls } : {}),
                },
                submitsForm: submitter && !!n.form,
              };
            },
            undefined,
            { timeout: STATE_READ_TIMEOUT_MS },
          )
          .catch(() => undefined)
      : undefined;
    const popup = read?.popup;
    return {
      visible,
      enabled,
      checked,
      ...(popup && Object.keys(popup).length > 0 ? { popup } : {}),
      ...(read?.submitsForm ? { submitsForm: true as const } : {}),
    };
  }

  /**
   * #225 review 4: the write guard has no release moment. Pressing happens in a throwaway browser process, in a context
   * made from the crawler's storage with the same options. Before that context exists, a Fetch interception on the
   * browser itself is on, and it is never taken off: every request whose method is not GET, HEAD or OPTIONS — from a
   * page, a tab it opens, a frame, any worker — is aborted (a form post, a fetch or XHR write, a beacon, whatever the
   * button that sent it was called) and recorded with the element pressed last before it. `release` kills the process.
   * Nothing flows back: the crawler's own context and page never saw a press.
   *
   * Why not a route on a context, closed at the end: a route's interception belongs to each page, frame and worker, and
   * goes when they go. What it holds is then let go: POSTs reached a probe server with the route on from a popup closing
   * itself, a cross-origin frame removed, a context closing (in full Chromium and Chrome), and also from a SharedWorker
   * and fetchLater, which it never saw. The browser's own interception saw them all, and a killed process runs no teardown.
   * Not covered: WebSocket messages, and a GET that changes the server against HTTP's rule.
   */
  async guardWrites(): Promise<WriteGuard> {
    if (this.pressing) throw new Error("The write guard is already on.");
    const page = await this.ensurePage();
    // A plain storageState leaves out IndexedDB and the tab's sessionStorage, where an app may keep its session.
    // ponytail: IndexedDB is copied whole, however large; sessionStorage only of the origin the crawler's page is on.
    const state = await this.context!.storageState({ indexedDB: true });
    const tab = await within<{ origin: string; items: [string, string][] } | undefined>(page.evaluate(readTabStorage), STATE_READ_TIMEOUT_MS, undefined);
    const server = await chromium.launchServer(this.launchOptions(`${BLINK_OFF},${SENDS_PAST_FETCH}`));
    const pressing = new PlaywrightLibBackend(this.opts);
    pressing.server = server;
    const blocked: BlockedRequest[] = [];
    try {
      pressing.browser = await chromium.connect(server.wsEndpoint());
      const cdp = await pressing.browser.newBrowserCDPSession();
      cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
        const method = request.method.toUpperCase();
        if (SAFE_METHODS.has(method)) {
          void cdp.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
          return;
        }
        const path = pressing.blockedPath(request.url);
        const pressed = pressing.lastPressed;
        const same = blocked.find((b) => b.method === method && b.path === path && b.pressed?.role === pressed?.role && b.pressed?.name === pressed?.name);
        if (same) same.count++;
        else blocked.push({ method, path, ...(pressed ? { pressed: { ...pressed } } : {}), count: 1 });
        // "Aborted" (net::ERR_ABORTED): a stopped form post leaves the page where it was, with no error page over it
        void cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => undefined);
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      pressing.context = await pressing.newContext(state);
      if (tab) await pressing.context.addInitScript(seedTabStorage, tab);
    } catch (e) {
      await server.kill().catch(() => undefined);
      throw e;
    }
    this.pressing = pressing;
    return {
      release: async () => {
        if (this.pressing === pressing) await this.discardPressing();
        return blocked.map((b) => ({ ...b }));
      },
    };
  }

  private async discardPressing(): Promise<void> {
    await this.pressing?.server?.kill().catch(() => undefined);
    this.pressing = undefined;
  }

  /** A stopped request's path, written like a recorded one; with its origin when that is not the page's. */
  private blockedPath(url: string): string {
    try {
      const own = this.page ? new URL(this.page.url()).origin : undefined;
      return new URL(url).origin === own ? recordedPath(url) : recordedUrl(url);
    } catch {
      return recordedUrl(url);
    }
  }

  session(): SessionApi {
    return {
      load: async (state: StorageState) => {
        await this.page?.close().catch(() => undefined);
        await this.context?.close().catch(() => undefined);
        this.page = undefined;
        this.browser ??= await this.launch();
        this.context = await this.newContext(state as unknown as PwStorageState);
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
    await this.discardPressing();
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }
}
