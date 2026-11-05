/**
 * Browser-layer contracts (ADR-0003). Shared by both backends and PageObserver.
 * `Observation` — raw observation from the backend; the normalized `PageStudy` is built by PageObserver.
 */

/** Stable element identifier for act() (the backend synthesizes them: e1, e2…). */
export interface ElementRef {
  ref: string;
  role: string;
  name?: string;
  /** Whether the element is interactive (button/textbox/link/checkbox…). */
  interactive: boolean;
  /** Testing importance (higher = more important). */
  rank: number;
  /** Resolved href for links (from the ARIA `/url` property) — used to dedup crawl links (#102). */
  url?: string;
  /**
   * #225: the dialog / alertdialog the element sits in (the innermost one). Its locator is then
   * `getByRole('dialog', { name }).getByRole(role, { name })`, so a same-named element on the page is not it.
   */
  scope?: OverlayScope;
  /** #225: the innermost dialog, alertdialog, menu, listbox or complementary the element sits in (what overlay detection groups by). */
  inside?: OverlayScope;
  /** #225: a modal overlay is open and this element is not in its top one — never touched while it is open. */
  underOverlay?: true;
  /**
   * #226: the named rows, list items, cards, sections and forms the element sits in, innermost first (not the dialog:
   * that is `scope`). When several visible elements share role and name, the container's name tells them apart:
   * `getByRole('row', { name }).getByRole(role, { name })`.
   */
  context?: OverlayScope[];
  /** #225: the snapshot marks it `[disabled]`. */
  disabled?: true;
}

/** #225: a container an element is looked for in: its role and accessible name. */
export interface OverlayScope {
  role: string;
  name?: string;
}

/** Observed element state (for act→observe grounding). */
export interface ElementState {
  visible: boolean;
  enabled: boolean;
  /** For checkable elements (switch/checkbox/radio); otherwise undefined. */
  checked?: boolean;
  /**
   * #225: what the element says it opens — `aria-haspopup` (when not "false"), `aria-expanded`, `aria-controls`.
   * The ARIA snapshot shows none of these but `[expanded]` when true, so the backend reads them from the element.
   * Absent when it could not be read (cli backend, element gone).
   */
  popup?: { hasPopup?: string; expanded?: boolean; controls?: string };
  /**
   * #225 review 2: pressing it submits a form — a submit button (`type=submit`, or a `<button>` with no type) inside
   * a form. Exploration never presses one, whatever it announces. Absent when it does not, or could not be read.
   */
  submitsForm?: true;
}

/** An element with a verified locator (verify-before-design, grounding). */
export interface VerifiedElement extends ElementRef {
  /** How many elements the getByRole(role,{name}) locator resolves to. */
  count: number;
  /** count === 1 — suitable for a reliable test. */
  verified: boolean;
  /**
   * #226: nothing tells it apart from the other visible elements of the same role and name in its scope (no named
   * row, card or section narrows it to one). Not clicked; reported as a finding.
   */
  ambiguous?: true;
  /** #226: the container whose name narrows several matches down to this one. */
  narrowedBy?: OverlayScope;
  /** If the element is hidden behind a tab/view — which switcher to click first (multi-state). */
  viaSwitcher?: { role: string; name?: string };
}

/** Raw page observation. */
export interface Observation {
  url: string;
  screenshotB64: string;
  ariaSnapshot: string;
  capturedBy: BackendKind;
  /** Page JS errors (console.error + uncaught) — a signal for error-aware design/repair. */
  consoleErrors?: string[];
  /** HTTP status of the navigation made by this observe() (only when `url` was given; lib backend only). */
  status?: number;
  /**
   * #225: the dialogs of the snapshot that the DOM says are NOT modal (`role|name`; no `aria-modal`, not `:modal`) —
   * a cookie banner leaves the page live. Absent on the cli backend: every dialog is then taken as modal.
   */
  nonModal?: string[];
}

/** HTTP Basic Auth for the browser context (values come from environment variables, never from a file). */
export interface HttpCredentials {
  username: string;
  password: string;
}

export type BackendKind = "lib" | "cli";

export interface ObserveOptions {
  /** If set — navigate to this URL first. */
  url?: string;
  /** Screenshot of the whole page (not just the viewport). */
  fullPage?: boolean;
  /**
   * If set — before snapshotting, wait (briefly, best-effort) for `location.href` to differ from this
   * value. Lets a client-routed SPA settle after a link click before we read the URL/DOM (#102).
   */
  waitForUrlChange?: string;
}

export type Action =
  | { kind: "navigate"; url: string }
  /**
   * `timeoutMs`: how long the click may wait for the element to be actionable (the backend's default otherwise).
   * `watch: false`: only click — nothing is watched or recorded (a probe's revert, a sign-in); watched by default.
   */
  | { kind: "click"; ref: string; timeoutMs?: number; watch?: boolean }
  | { kind: "fill"; ref: string; value: string }
  /** #225 (lib backend): press a key on the page, e.g. `Escape`. */
  | { kind: "press"; key: string }
  /**
   * #225 (lib backend): click on the page outside the overlay `scope`, at a point checked first: the element there is
   * outside the overlay and is nothing a click acts on (no link, button, field, click role or handler cursor). When no
   * such point is found nothing is clicked and the result is not ok.
   */
  | { kind: "click-outside"; scope: OverlayScope };

/**
 * What a click did (#224), most telling first: one name from a closed set. `no-effect` is a click after which Cairn
 * saw no change (a dead click); `unknown` is one it could not judge (the page could not be read, a navigation was
 * still on its way) — never a dead click.
 */
export type ClickEffectKind =
  | "navigated"
  | "opened-tab"
  | "downloaded"
  | "overlay-opened"
  | "overlay-closed"
  | "state-changed"
  | "content-changed"
  | "network-only"
  | "unknown"
  | "no-effect";

/**
 * Why a click failed (#224). `intercepted`: another element takes the pointer — an overlay exploration does not know.
 * `ambiguous` (#226): several visible elements share its role and name and no named row, card or section tells them
 * apart, so none was clicked.
 * `under-overlay` (#225): the element lies under a modal overlay that is open, so it was not clicked at all.
 * `not-found`: nothing matches the element observed a moment ago; `detached`: it was found, then left the page.
 */
export type ClickFailure = "ambiguous" | "under-overlay" | "intercepted" | "not-visible" | "not-enabled" | "detached" | "not-found" | "timeout";

export type ClickOutcome = ClickEffectKind | ClickFailure;

/** #226: an element Cairn would not click because nothing tells it apart from `count` others like it in its scope. */
export interface AmbiguousElement {
  role: string;
  name?: string;
  /** How many visible elements of this role and name were there. */
  count: number;
  /** The scope it was looked for in: a dialog, when it was inside one. */
  scope?: OverlayScope;
}

/** #226: an element exploration could not tell apart from others like it: a finding of the run, not a click. */
export interface AmbiguousFinding extends AmbiguousElement {
  /** The page it was on. */
  page: string;
}

/** A request the page started after a click: method, path and status only — no body, no header, no query value. */
export interface RecordedRequest {
  method: string;
  /** Path on the page's own origin, with query keys and no values: `/api/save?token=‹v›&page=‹v›`. */
  path: string;
  /** Absent when no answer came within the wait. */
  status?: number;
}

/**
 * #225 review 3: a request the write guard stopped — any method but GET, HEAD or OPTIONS, sent while the guard was on.
 * Written like a recorded request (no body, no header, no query value); `count` is how often the same one was stopped.
 */
export interface BlockedRequest {
  method: string;
  /** {@link RecordedRequest.path}; prefixed with its origin when that is not the page's. */
  path: string;
  /** The element pressed last before the request was sent (absent when nothing had been pressed yet). */
  pressed?: { role: string; name?: string };
  count: number;
}

/**
 * #225 review 3: the network guard of a backend. While it is on, every request of the browser context whose method is
 * not GET, HEAD or OPTIONS (a form post, a fetch or XHR write, a beacon) is aborted before it leaves the browser.
 */
export interface WriteGuard {
  /** Lifts the guard and returns what it stopped, in the order first seen. */
  release(): Promise<BlockedRequest[]>;
}

/** What one click changed (#224) — recorded by the lib backend after every click it watches. */
export interface ClickEffect {
  outcome: ClickEffectKind;
  /** The page the click was made on, and the element clicked. */
  page: string;
  role: string;
  name?: string;
  /** The URL after the click, when it changed. */
  url?: string;
  /** The tab the click opened (its URL, written like a recorded request), and the file it downloaded. */
  tab?: string;
  download?: string;
  /** `dialog` / `alertdialog` / `menu` / `listbox` that appeared or went away, as `dialog "Edit"`. */
  opened: string[];
  closed: string[];
  /** The page's ARIA snapshot before vs after, line by line — read again only when the DOM changed. */
  added: string[];
  removed: string[];
  /** Visible text the page added after the click, kept even when it was gone again (a toast). */
  appeared: string[];
  /** The element's own checked / expanded / pressed / selected, and the page's focus and scroll, that changed. */
  state: { attr: "checked" | "expanded" | "pressed" | "selected" | "focus" | "scroll"; before: string; after: string }[];
  /** Document, fetch and XHR requests on the page's origin started after the click, polls left out. */
  requests: RecordedRequest[];
}

export interface ActResult {
  /** The action happened. For a click: it was made — whether it changed anything is `outcome`. */
  ok: boolean;
  ref?: string;
  error?: string;
  /**
   * A click on the lib backend (#224): its effect when `ok`, its cause when not. Absent for a click that never
   * reached the page (an unknown ref) or failed for another reason (the page closed), and on the cli backend.
   */
  outcome?: ClickOutcome;
  /** What the click changed, when it was made (lib backend). */
  effect?: ClickEffect;
  /** #226: set with `outcome: "ambiguous"`: what could not be told apart, and how many there were. */
  ambiguous?: AmbiguousElement;
}

/**
 * Playwright storageState structure (JSON): cookies + per-origin localStorage.
 * Defined structurally so that SessionStore and the gateway do not pull in playwright types directly.
 */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    [k: string]: unknown;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface SessionApi {
  /** Load saved state into the current browser session. */
  load(state: StorageState): Promise<void>;
  /** Capture the current state (cookies + localStorage). */
  save(): Promise<StorageState>;
}

/** Run report for the generated tests (populated in Sprint 3). */
export interface TestRunReport {
  passed: number;
  failed: number;
  flaky: number;
}
