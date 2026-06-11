import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { locatorFor } from "../artifacts/report.js";
import type { ElementRef } from "../browser/index.js";

export interface PromoteDeps {
  /**
   * Live browser fallback for refs missing from study.json. Omit → offline-only.
   *
   * Returns a `Map<ref, locator>` only — element names are not available in the
   * live path, so any selector produced here will be labeled by its ref string
   * (e.g. `"e99"`) rather than a human-readable name.
   */
  collectLive?: (url: string, refs: string[]) => Promise<Map<string, string>>;
}

export interface CollectedSelectors {
  selectors: { label: string; locator: string }[];
  missing: string[];
}

/**
 * Build selectors for the given elementRefs.
 *
 * Resolution order: study.json (offline) → optional live browser fallback.
 *
 * **Label convention:**
 * - Elements found in study.json → `label` is `name ?? role` (human-readable).
 * - Elements found only via `collectLive` → `label` is the ref string (e.g. `"e99"`),
 *   because the live path returns locators only and does not expose element names.
 */
export async function collectSelectors(
  runDir: string,
  elementRefs: string[],
  deps: PromoteDeps = {},
): Promise<CollectedSelectors> {
  let elements: ElementRef[] = [];
  try {
    const study = JSON.parse(await readFile(join(runDir, "study.json"), "utf8")) as {
      elements?: ElementRef[];
    };
    elements = study.elements ?? [];
  } catch {
    // no study.json — every ref is missing (live fallback may still fill them)
  }
  const byRef = new Map(elements.map((e) => [e.ref, e]));

  const selectors: { label: string; locator: string }[] = [];
  const missing: string[] = [];
  for (const ref of elementRefs) {
    const el = byRef.get(ref);
    if (el) selectors.push({ label: el.name ?? el.role, locator: locatorFor(el) });
    else missing.push(ref);
  }

  if (missing.length === 0 || !deps.collectLive) return { selectors, missing };

  let url = "";
  try {
    const rep = JSON.parse(await readFile(join(runDir, "report.json"), "utf8")) as { url?: string };
    url = rep.url ?? "";
  } catch {
    // no report.json → cannot navigate
  }
  if (!url) {
    // collectLive provided but no url available → cannot navigate; leave refs in missing
    return { selectors, missing };
  }

  const live = await deps.collectLive(url, missing);
  const stillMissing: string[] = [];
  for (const ref of missing) {
    const loc = live.get(ref);
    if (loc) selectors.push({ label: ref, locator: loc });
    else stillMissing.push(ref);
  }
  return { selectors, missing: stillMissing };
}
