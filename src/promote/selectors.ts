import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { locatorFor } from "../artifacts/report.js";
import type { ElementRef } from "../browser/index.js";

export interface PromoteDeps {
  /** Live browser fallback for refs missing from study.json. Omit → offline-only. */
  collectLive?: (url: string, refs: string[]) => Promise<Map<string, string>>;
}

export interface CollectedSelectors {
  selectors: { label: string; locator: string }[];
  missing: string[];
}

/** Build selectors for elementRefs: study.json (offline) first, then an optional live fallback. */
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
  if (!url) return { selectors, missing };

  const live = await deps.collectLive(url, missing);
  const stillMissing: string[] = [];
  for (const ref of missing) {
    const loc = live.get(ref);
    if (loc) selectors.push({ label: ref, locator: loc });
    else stillMissing.push(ref);
  }
  return { selectors, missing: stillMissing };
}
