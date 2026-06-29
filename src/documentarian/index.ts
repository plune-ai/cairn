/**
 * BORROW-06 (#93) — Documentarian: a cached, reusable page-understanding artifact.
 *
 * Decouples "understand the page" from "generate tests": a run turns the live page into a strict-schema
 * {@link InteractionMap} (element → locator + container + candidate actions) and caches it keyed by
 * `url + page fingerprint`. A second run on the SAME page (identical ARIA → identical fingerprint) reuses
 * the cached understanding and SKIPS the ground LLM call (`analyzePage`), so it makes fewer observe/ground
 * LLM calls. The map is assembled DETERMINISTICALLY from what observe/verify/probe already produce — no
 * extra LLM call is introduced (idea borrowed from explorbot's doc-collector; strict schema per #89).
 *
 * Cache invalidation is deliberate: the key embeds a fingerprint of the page's ARIA snapshot, so any
 * structural change to the page misses the cache and re-grounds. Cross-run / per-app memory (semantic
 * retrieval) is OUT of scope here — that is MEM-02 (#64).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PageStudy } from "../observe/index.js";
import type { PageAnalysis } from "../analyze/index.js";
import type { VerifiedElement } from "../browser/types.js";
import type { Transition } from "../probe/index.js";
import { locatorFor } from "../artifacts/report.js";

/** Bump when the artifact shape changes → older cached files are treated as a miss. */
export const UNDERSTANDING_SCHEMA_VERSION = 1;

/** One interactive element, distilled for reuse: a stable locator + how it can be driven. */
export const InteractionElementSchema = z.object({
  ref: z.string(),
  role: z.string(),
  name: z.string().optional(),
  /** Playwright locator expression (getByRole(...), `.first()` for repeated elements). */
  locator: z.string(),
  /** The view/tab this element lives behind, when known (multi-state pages). */
  container: z.string().optional(),
  /** Actions the element affords: click | fill | check | assertVisible. */
  candidateActions: z.array(z.string()),
});
export type InteractionElement = z.infer<typeof InteractionElementSchema>;

/** The cached page-understanding artifact: page semantics + the interaction map. */
export const InteractionMapSchema = z.object({
  schemaVersion: z.number(),
  url: z.string(),
  /** Hash of the page's ARIA snapshot — the cache key for deliberate invalidation on page change. */
  fingerprint: z.string(),
  pageSemantics: z.string(),
  primaryRefs: z.array(z.string()),
  viewSwitchers: z.array(z.string()),
  elements: z.array(InteractionElementSchema),
});
export type InteractionMap = z.infer<typeof InteractionMapSchema>;

/** Page fingerprint = hash of the ARIA snapshot. Same ARIA ⇒ same refs ⇒ cached understanding is valid. */
export function fingerprintPage(study: PageStudy): string {
  return createHash("sha256").update(study.ariaYaml).digest("hex").slice(0, 16);
}

/** Actions an element affords — from its role, plus any observed act→observe transition. */
function candidateActionsFor(el: VerifiedElement, transitions: Transition[]): string[] {
  const acts = new Set<string>();
  const r = el.role.toLowerCase();
  if (/button|link|tab|menuitem|option/.test(r)) acts.add("click");
  if (/textbox|searchbox|combobox|spinbutton/.test(r)) acts.add("fill");
  if (/checkbox|switch|radio/.test(r)) acts.add("check");
  if (transitions.some((t) => t.ref === el.ref)) acts.add("click"); // a real observed transition
  if (acts.size === 0) acts.add("assertVisible"); // non-interactive → static check only
  return [...acts];
}

/**
 * Assemble the interaction map deterministically from this run's observe/ground/verify/probe outputs.
 * No LLM call: locators come from {@link locatorFor}, actions from role + observed transitions, and the
 * container from the element's tab/view switcher when present.
 */
export function buildInteractionMap(
  study: PageStudy,
  analysis: PageAnalysis,
  verified: VerifiedElement[],
  transitions: Transition[],
  fingerprint: string,
): InteractionMap {
  const elements: InteractionElement[] = verified
    .filter((v) => v.count >= 1)
    .map((v) => ({
      ref: v.ref,
      role: v.role,
      name: v.name,
      locator: `${locatorFor(v)}${v.count > 1 ? ".first()" : ""}`,
      // ponytail: container = the tab/view the element sits behind (known deterministically). Richer
      // landmark/region inference from the ARIA tree is a follow-up if reviewers want it.
      container: v.viaSwitcher ? `${v.viaSwitcher.role} "${v.viaSwitcher.name ?? ""}"` : undefined,
      candidateActions: candidateActionsFor(v, transitions),
    }));
  return {
    schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
    url: study.url,
    fingerprint,
    pageSemantics: analysis.pageSemantics,
    primaryRefs: analysis.primaryRefs,
    viewSwitchers: analysis.viewSwitchers,
    elements,
  };
}

/** Re-derive a {@link PageAnalysis} from a cached map (grounded against the current refs). */
export function analysisFromMap(map: InteractionMap, currentRefs: Set<string>): PageAnalysis {
  return {
    pageSemantics: map.pageSemantics,
    primaryRefs: map.primaryRefs.filter((r) => currentRefs.has(r)),
    viewSwitchers: map.viewSwitchers.filter((r) => currentRefs.has(r)),
  };
}

/** Stable, filesystem-safe cache filename for a URL (the page is disambiguated by the fingerprint inside). */
function cacheFile(cacheDir: string, url: string): string {
  return join(cacheDir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`);
}

/**
 * Load a cached understanding for `url` IFF it matches the current page `fingerprint` and schema version.
 * A miss (no file, stale fingerprint, old/corrupt shape) returns undefined → the caller re-grounds.
 */
export async function loadUnderstanding(
  cacheDir: string,
  url: string,
  fingerprint: string,
): Promise<InteractionMap | undefined> {
  try {
    const parsed = InteractionMapSchema.safeParse(JSON.parse(await readFile(cacheFile(cacheDir, url), "utf8")));
    if (!parsed.success) return undefined; // old/corrupt shape → miss
    const map = parsed.data;
    if (map.schemaVersion !== UNDERSTANDING_SCHEMA_VERSION) return undefined;
    if (map.url !== url || map.fingerprint !== fingerprint) return undefined; // page changed → invalidate
    return map;
  } catch {
    return undefined; // no cache yet → miss
  }
}

/** Persist the understanding to the cross-run cache. Best-effort: a write failure never breaks a run. */
export async function saveUnderstanding(cacheDir: string, map: InteractionMap): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile(cacheDir, map.url), JSON.stringify(map, null, 2), "utf8");
  } catch {
    // cache write is best-effort
  }
}
