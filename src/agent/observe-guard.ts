import type { ElementRef } from "../browser/types.js";

/** Privacy-preserving first: reject / decline / only-necessary controls. */
const DISMISS_PATTERNS = [
  /only necessary|necessary only|only essential|essential only|reject non-essential/i,
  /reject all/i,
  /\breject\b/i,
  /\bdecline\b/i,
  /\brefuse\b/i,
];

/** Fallback: an explicit accept — used ONLY to clear a hard wall when nothing to decline exists. */
const ACCEPT_PATTERNS = [/accept all/i, /\baccept\b/i, /\bagree\b/i, /allow all/i, /\bgot it\b/i];

/**
 * Pick a cookie/consent control to dismiss BEFORE studying the page (L1-04, Box 1).
 * Privacy-preserving default: prefer "reject / decline / only necessary"; fall back to an explicit
 * "accept" only to clear a hard wall that would otherwise block the whole run. Returns the element to
 * click, or undefined when no obvious consent wall is present.
 */
export function findConsentDismiss(elements: ElementRef[]): ElementRef | undefined {
  const controls = elements.filter(
    (e) => e.interactive && (e.role === "button" || e.role === "link") && Boolean(e.name),
  );
  for (const re of DISMISS_PATTERNS) {
    const hit = controls.find((c) => re.test(c.name ?? ""));
    if (hit) return hit;
  }
  for (const re of ACCEPT_PATTERNS) {
    const hit = controls.find((c) => re.test(c.name ?? ""));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Turn a raw navigation/observe failure into a single readable line for the user (L1-04, Box 1) —
 * never a stack trace. Classifies timeout vs unreachable vs other; always one line, always names the URL.
 */
export function describeObserveError(err: unknown, url: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = (raw.split(/\r?\n/)[0] ?? "").trim();
  if (/timeout|timed out/i.test(first)) {
    return `Could not load ${url}: the page timed out. Check the URL/network, or the app may be slow — try again.`;
  }
  if (/net::ERR|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|dns|getaddrinfo/i.test(first)) {
    return `Could not reach ${url}: navigation failed (DNS/connection). Check the URL is correct and reachable.`;
  }
  return `Could not load ${url}: ${first || "navigation failed"}`;
}
