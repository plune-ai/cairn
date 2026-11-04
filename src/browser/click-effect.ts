import { credentialShaped, redact, secretValues } from "../decider/redact.js";
import type { ClickEffect, ClickEffectKind, ClickFailure, RecordedRequest } from "./types.js";

/**
 * What a click did (#224), from what the lib backend saw around it: the URL, the page's ARIA snapshot before and
 * after, and the requests it started. Pure, so every decision here is tested without a browser.
 */

/** A role that opens over the page, with its name: `dialog "Edit"` (not `menubar`, not `menuitem`). */
const OVERLAY = /^- ((?:dialog|alertdialog|menu|listbox)(?: "[^"]*")?)(?=[\s:[]|$)/;
/** Playwright writes a true state as `[checked]` and a tri-state as `[checked=mixed]`; a false one not at all. */
const STATE = /\[(checked|expanded|pressed|selected)(?:=(\w+))?\]/g;
const ATTRS = ["checked", "expanded", "pressed", "selected"] as const;

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

/** The state of the first line with this role and name — the element `getByRole(…).first()` clicked. */
function stateOf(lines: string[], role: string, name?: string): Record<string, string> | undefined {
  const line = lines.find((l) => /^- ([a-zA-Z][\w-]*)/.exec(l)?.[1] === role && /"([^"]*)"/.exec(l)?.[1] === name);
  return line === undefined ? undefined : Object.fromEntries([...line.matchAll(STATE)].map((m) => [m[1], m[2] ?? "true"]));
}

export interface ClickEffectInput {
  /** The URL before the click, and after it. */
  page: string;
  url: string;
  role: string;
  name?: string;
  /** The page's ARIA snapshot before and after; absent when it could not be read. */
  before?: string;
  after?: string;
  requests: RecordedRequest[];
}

export function clickEffect(i: ClickEffectInput): ClickEffect {
  const navigated = i.url !== i.page;
  const compare = !navigated && i.before !== undefined && i.after !== undefined;
  const before = compare ? linesOf(i.before!) : [];
  const after = compare ? linesOf(i.after!) : [];
  const added = minus(after, before);
  const removed = minus(before, after);
  const s0 = stateOf(before, i.role, i.name);
  const s1 = stateOf(after, i.role, i.name);
  const state = ATTRS.flatMap((attr) => {
    if (!s0 || !s1) return []; // the element is not on one side: its line cannot be compared
    const [b, a] = [s0[attr] ?? "false", s1[attr] ?? "false"];
    return b === a ? [] : [{ attr, before: b, after: a }];
  });
  const effect = {
    page: i.page,
    role: i.role,
    ...(i.name !== undefined ? { name: i.name } : {}),
    ...(navigated ? { url: i.url } : {}),
    opened: overlays(added),
    closed: overlays(removed),
    added,
    removed,
    state,
    requests: i.requests,
  };
  return { outcome: outcomeOf(effect), ...effect };
}

/** The most telling change names the click; a request counts only when nothing visible changed and it answered 2xx. */
function outcomeOf(e: Omit<ClickEffect, "outcome">): ClickEffectKind {
  if (e.url !== undefined) return "navigated";
  if (e.opened.length > 0) return "overlay-opened";
  if (e.closed.length > 0) return "overlay-closed";
  if (e.state.length > 0) return "state-changed";
  if (e.added.length > 0 || e.removed.length > 0) return "content-changed";
  if (e.requests.some((r) => r.status !== undefined && r.status >= 200 && r.status < 300)) return "network-only";
  return "no-effect";
}

/** Causes Playwright's call log names, read from its last line back: the latest attempt says why the click failed. */
const CAUSES: [RegExp, ClickFailure][] = [
  [/intercepts pointer events/, "intercepted"],
  [/element is not visible/, "not-visible"],
  [/element is not enabled/, "not-enabled"],
  [/not attached to the DOM|element was detached/i, "detached"],
];

export function clickFailure(message: string): ClickFailure | undefined {
  for (const line of message.split("\n").reverse()) {
    const cause = CAUSES.find(([re]) => re.test(line));
    if (cause) return cause[1];
  }
  if (!/Timeout \d+ms exceeded/.test(message)) return undefined; // the page closed, the browser went away: no click cause
  // Nothing matches the element observed a moment ago: it is gone from the page.
  // ponytail: getByRole skips hidden elements, so one hidden since the observe reads as detached too; a second
  // count with { includeHidden: true } would tell them apart if that ever matters.
  return message.includes("locator resolved to") ? "timeout" : "detached";
}

/**
 * A request's path and query as the run keeps it: a query value's words shaped like a credential, and the value of
 * a parameter named for a secret (`password=…`, `api_key=…`), go through the same redaction as the decider's state.
 */
export function recordedPath(url: string): string {
  const u = new URL(url);
  const query = [...u.searchParams].map(
    ([k, v]) => `${k}=${redact(v, [...v.split(/\s+/).filter((w) => credentialShaped(w)), ...secretValues(`${k}: ${v}`, {})])}`,
  );
  return query.length > 0 ? `${u.pathname}?${query.join("&")}` : u.pathname;
}
