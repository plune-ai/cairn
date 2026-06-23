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
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string };

export interface ActResult {
  ok: boolean;
  ref?: string;
  error?: string;
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
