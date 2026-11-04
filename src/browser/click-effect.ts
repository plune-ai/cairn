import type { ClickEffect, ClickEffectKind, ClickFailure, RecordedRequest } from "./types.js";

/**
 * What a click did (#224), from what the lib backend saw around it: the URL, a new tab or a download, what the page
 * itself noticed (the element's state, the focus, the scroll, its DOM changes), the ARIA snapshot when the DOM
 * changed, and the requests the click started. The decision is pure, so it is tested without a browser.
 */

/** How long a click is watched before the page is read: a handler changes the DOM and calls fetch() within a frame or two. */
export const CLICK_EFFECT_WINDOW_MS = 250;
/** The longest the requests a click started are waited for while in flight, whatever their origin: they may render when they answer. */
export const REQUEST_ANSWER_MS = 2_000;
/**
 * A click that looks dead is read again until this long after it. A debounced handler (300–500 ms is common), a late
 * pushState or a slow render shows within about a second; only the clicks that look dead pay for this wait.
 */
export const DEAD_CLICK_RECHECK_MS = 1_200;

/** A role that opens over the page, with its name: `dialog "Edit"` (not `menubar`, not `menuitem`). */
const OVERLAY = /^- ((?:dialog|alertdialog|menu|listbox)(?: "[^"]*")?)(?=[\s:[]|$)/;

const linesOf = (aria: string): string[] => aria.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The lines of `a` that `b` lacks, repeats counted: a list of three rows that became two lost one. */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  return a.filter((l) => {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    return n === 0;
  });
}

const overlays = (lines: string[]): string[] =>
  lines.flatMap((l) => {
    const m = OVERLAY.exec(l);
    return m?.[1] ? [m[1]] : [];
  });

/** What the page-side watch saw after the click. */
export interface PageSeen {
  /** The element's own state, the focus and the scroll that changed. */
  state: ClickEffect["state"];
  /** The DOM changed at all since the click (a node, a text, an attribute). */
  mutated: boolean;
  /** Visible text the page added, kept when it is gone again. */
  appeared: string[];
}

export interface ClickEffectInput {
  /** The URL before the click, and now. */
  page: string;
  url: string;
  role: string;
  name?: string;
  tab?: string;
  download?: string;
  /** Absent when the page-side watch could not be put in place or read. */
  seen?: PageSeen;
  /** The ARIA snapshot before the click (the page as last read) and after it — read only when the DOM changed. */
  before?: string;
  after?: string;
  requests: RecordedRequest[];
  /** A navigation of the page the click started has not answered yet. */
  navigating?: boolean;
}

export function clickEffect(i: ClickEffectInput): ClickEffect {
  const navigated = i.url !== i.page;
  const diffed = !navigated && i.seen?.mutated === true && i.before !== undefined && i.after !== undefined;
  const before = diffed ? linesOf(i.before!) : [];
  const after = diffed ? linesOf(i.after!) : [];
  const added = minus(after, before);
  const removed = minus(before, after);
  const effect = {
    page: i.page,
    role: i.role,
    ...(i.name !== undefined ? { name: i.name } : {}),
    ...(navigated ? { url: i.url } : {}),
    ...(i.tab !== undefined ? { tab: i.tab } : {}),
    ...(i.download !== undefined ? { download: i.download } : {}),
    opened: overlays(added),
    closed: overlays(removed),
    added,
    removed,
    appeared: i.seen?.appeared ?? [],
    state: i.seen?.state ?? [],
    requests: i.requests,
  };
  return { outcome: outcomeOf(effect, i), ...effect };
}

/** The most telling change names the click. Whatever could not be read is unknown: a dead click needs evidence of nothing. */
function outcomeOf(e: Omit<ClickEffect, "outcome">, i: ClickEffectInput): ClickEffectKind {
  if (e.url !== undefined) return "navigated";
  if (e.tab !== undefined) return "opened-tab";
  if (e.download !== undefined) return "downloaded";
  if (!i.seen || (i.seen.mutated && (i.before === undefined || i.after === undefined))) return "unknown";
  if (e.opened.length > 0) return "overlay-opened";
  if (e.closed.length > 0) return "overlay-closed";
  if (e.state.length > 0) return "state-changed";
  if (e.added.length > 0 || e.removed.length > 0 || e.appeared.length > 0) return "content-changed";
  if (e.requests.some((r) => r.status !== undefined && r.status >= 200 && r.status < 300)) return "network-only";
  if (i.navigating) return "unknown";
  return "no-effect";
}

/** Causes Playwright's call log names, read from its last line back: the latest attempt says why the click failed. */
const CAUSES: [RegExp, ClickFailure][] = [
  [/intercepts pointer events/, "intercepted"],
  [/element is not visible/, "not-visible"],
  [/element is not enabled/, "not-enabled"],
  [/not attached to the DOM|element was detached/i, "detached"],
];

/** `not-found` when the locator matched nothing; the backend then counts hidden matches to tell `not-visible` from it. */
export function clickFailure(message: string): ClickFailure | undefined {
  for (const line of message.split("\n").reverse()) {
    const cause = CAUSES.find(([re]) => re.test(line));
    if (cause) return cause[1];
  }
  if (!/Timeout \d+ms exceeded/.test(message)) return undefined; // the page closed, the browser went away: no click cause
  return message.includes("locator resolved to") ? "timeout" : "not-found";
}

const V = "‹v›";

/** How often a run of letters switches case: random text flips about every other letter, a CamelCase word rarely. */
function caseFlips(run: string): number {
  let n = 0;
  for (let k = 1; k < run.length; k++) if (/[A-Z]/.test(run[k]!) !== /[A-Z]/.test(run[k - 1]!)) n += 1;
  return n;
}

/**
 * A path segment or query key that may be a credential or an id: a JWT, long hex, a UUID, a long number, a run of 8+
 * letters mixed with digits, or 16+ letters whose case flips like random text. Words, slugs, short ids and `v2` stay.
 */
export function secretShaped(s: string): boolean {
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(s)) return true; // JWT: header.payload.signature
  if (/^[0-9a-f]{16,}$/i.test(s) || /^\d{12,}$/.test(s) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)) return true;
  return s
    .split(/[^A-Za-z0-9]+/)
    .some((run) => (run.length >= 8 && /\d/.test(run) && /[A-Za-z]/.test(run)) || (run.length >= 16 && caseFlips(run) >= run.length / 3));
}

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * A request's path as the run keeps it: every query value becomes `‹v›` and so does a credential-shaped query key or
 * path segment; `;jsessionid=…` and other `;` parameters are dropped. `/reset/9f86…?token=x&page=2` → `/reset/‹v›?token=‹v›&page=‹v›`.
 */
export function recordedPath(url: string): string {
  const u = new URL(url);
  const path = u.pathname
    .split("/")
    .map((seg) => {
      const bare = seg.split(";")[0] ?? "";
      return secretShaped(decoded(bare)) ? V : bare;
    })
    .join("/");
  const keys = [...u.searchParams.keys()].map((k) => `${secretShaped(k) ? V : k}=${V}`);
  return keys.length > 0 ? `${path}?${keys.join("&")}` : path;
}

/** A page URL as a report shows it: its origin (no user, no password) and {@link recordedPath}; no fragment. */
export function recordedUrl(url: string): string {
  try {
    return `${new URL(url).origin}${recordedPath(url)}`;
  } catch {
    return V;
  }
}

/** The page-side watch lives under this key of the page's window while one click is watched; it is removed after. */
export const WATCH_KEY = "__cairnClickWatch";

/**
 * Put in the page right before the click, as source (so no bundler helper can reach into it). It notes the clicked
 * element's checked / expanded / pressed / selected, the focus and the scroll as the pointer goes down, and every DOM
 * change after — keeping the visible text a change added, so a toast gone by the time the page is read is seen.
 */
const INSTALL_WATCH = String.raw`(key) => {
  const prev = window[key];
  if (prev && prev.observer) prev.observer.disconnect();
  const stateOf = (el) => el && el.isConnected ? {
    checked: el.indeterminate ? "mixed" : el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.getAttribute("aria-checked") || "false",
    expanded: el.getAttribute("aria-expanded") || "false",
    pressed: el.getAttribute("aria-pressed") || "false",
    selected: el.tagName === "OPTION" ? String(el.selected) : el.getAttribute("aria-selected") || "false",
  } : null;
  const target = prev ? prev.target : null;
  const s = { target, stateOf, before: stateOf(target), focus: document.activeElement, x: scrollX, y: scrollY, mutated: false, fresh: false, appeared: [], scanned: 0 };
  s.observer = new MutationObserver((records) => {
    s.mutated = true;
    s.fresh = true;
    for (const r of records) for (const n of r.addedNodes) {
      if (s.appeared.length >= 5 || s.scanned++ >= 200) return;
      const host = n.nodeType === 1 ? n : n.parentElement;
      if (!host || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(host.tagName)) continue;
      if (host.checkVisibility && !host.checkVisibility()) continue;
      const text = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (text) s.appeared.push(text.slice(0, 80));
    }
  });
  s.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  s.down = () => { s.focus = document.activeElement; s.x = scrollX; s.y = scrollY; };
  addEventListener("pointerdown", s.down, { capture: true, once: true });
  window[key] = s;
}`;

/** Read in the page after the click: what changed since the watch was put in place; `fresh` = DOM changed since the last read. */
const READ_WATCH = String.raw`(key) => {
  const s = window[key];
  if (!s) return null;
  const state = [];
  const now = s.stateOf(s.target);
  if (s.before && now) for (const attr of ["checked", "expanded", "pressed", "selected"]) {
    if (s.before[attr] !== now[attr]) state.push({ attr, before: s.before[attr], after: now[attr] });
  }
  const label = (el) => !el ? "none" : el === document.body ? "body" : el.getAttribute("aria-label") || el.id || el.getAttribute("name") || el.tagName.toLowerCase();
  const a = document.activeElement;
  const t = s.target;
  // Focus that lands on the clicked element (a button takes it) or leaves for nothing (a blur) is no effect.
  if (a && a !== document.body && a !== s.focus && !(t && (a.contains(t) || t.contains(a)))) {
    state.push({ attr: "focus", before: label(s.focus), after: label(a) });
  }
  if (scrollX !== s.x || scrollY !== s.y) state.push({ attr: "scroll", before: s.x + "," + s.y, after: scrollX + "," + scrollY });
  const fresh = s.fresh;
  s.fresh = false;
  return { state, mutated: s.mutated, fresh, appeared: s.appeared.slice() };
}`;

const REMOVE_WATCH = String.raw`(key) => {
  const s = window[key];
  if (s && s.observer) s.observer.disconnect();
  if (s && s.down) removeEventListener("pointerdown", s.down, true);
  delete window[key];
}`;

/** The page-side scripts, called with the watch key. */
export const watchScript = {
  install: `(${INSTALL_WATCH})(${JSON.stringify(WATCH_KEY)})`,
  read: `(${READ_WATCH})(${JSON.stringify(WATCH_KEY)})`,
  remove: `(${REMOVE_WATCH})(${JSON.stringify(WATCH_KEY)})`,
};
