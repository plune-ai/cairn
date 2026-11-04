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
}

/** Observed element state (for act→observe grounding). */
export interface ElementState {
  visible: boolean;
  enabled: boolean;
  /** For checkable elements (switch/checkbox/radio); otherwise undefined. */
  checked?: boolean;
}

/** An element with a verified locator (verify-before-design, grounding). */
export interface VerifiedElement extends ElementRef {
  /** How many elements the getByRole(role,{name}) locator resolves to. */
  count: number;
  /** count === 1 — suitable for a reliable test. */
  verified: boolean;
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
  /** `timeoutMs`: how long the click may wait for the element to be actionable (the backend's default otherwise). */
  | { kind: "click"; ref: string; timeoutMs?: number }
  | { kind: "fill"; ref: string; value: string };

/** What a click did (#224), most telling first: one name from a closed set. `no-effect` is a dead click. */
export type ClickEffectKind =
  | "navigated"
  | "overlay-opened"
  | "overlay-closed"
  | "state-changed"
  | "content-changed"
  | "network-only"
  | "no-effect";

/** Why a click failed (#224). `intercepted`: another element takes the pointer — an overlay exploration does not know. */
export type ClickFailure = "intercepted" | "not-visible" | "not-enabled" | "detached" | "timeout";

export type ClickOutcome = ClickEffectKind | ClickFailure;

/** A request the page started after a click: no body, no headers; query values that look like secrets are redacted. */
export interface RecordedRequest {
  method: string;
  /** Path and query on the page's own origin. */
  path: string;
  /** Absent when no answer came within the wait. */
  status?: number;
}

/** What one click changed (#224) — recorded by the lib backend after every click it makes. */
export interface ClickEffect {
  outcome: ClickEffectKind;
  /** The page the click was made on, and the element clicked. */
  page: string;
  role: string;
  name?: string;
  /** The URL after the click, when it changed. */
  url?: string;
  /** `dialog` / `alertdialog` / `menu` / `listbox` that appeared or went away, as `dialog "Edit"`. */
  opened: string[];
  closed: string[];
  /** The page's ARIA snapshot before vs after, line by line (not compared across a navigation). */
  added: string[];
  removed: string[];
  /** The element's own checked / expanded / pressed / selected that changed. */
  state: { attr: "checked" | "expanded" | "pressed" | "selected"; before: string; after: string }[];
  /** Document, fetch and XHR requests on the page's origin started right after the click. */
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
