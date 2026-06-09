import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Summary of a prior run (from runs/<id>/report.json). */
export interface PriorRun {
  runId: string;
  url: string;
  greenRatio: number;
  passedTests: string[];
}

interface ReportShape {
  url?: string;
  validation?: { greenRatio?: number; results?: { test: string; status: string }[] };
}

/**
 * Collect prior runs of the same URL from local artifacts (runs/<id>/report.json),
 * sorted by greenRatio (best first). A source of self-improvement at the RESULTS level.
 * (The production path is querying traces/scores from Langfuse by URL metadata; here it's a local trail.)
 */
export async function collectPriorRuns(runsBaseDir: string, url: string): Promise<PriorRun[]> {
  let dirs: string[] = [];
  try {
    dirs = await readdir(runsBaseDir);
  } catch {
    return [];
  }

  const out: PriorRun[] = [];
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(runsBaseDir, dir, "report.json"), "utf8");
      const rep = JSON.parse(raw) as ReportShape;
      if (rep.url !== url) continue;
      out.push({
        runId: dir,
        url,
        greenRatio: rep.validation?.greenRatio ?? 0,
        passedTests: (rep.validation?.results ?? [])
          .filter((r) => r.status === "passed")
          .map((r) => r.test),
      });
    } catch {
      // not a run / unreadable — skip
    }
  }
  return out.sort((a, b) => b.greenRatio - a.greenRatio);
}

/** All tests that EVER passed for the URL (union of the best across runs). */
export function unionPassedTitles(runs: PriorRun[]): string[] {
  const set = new Set<string>();
  for (const r of runs) for (const t of r.passedTests) set.add(t);
  return [...set];
}

/** Few-shot from experience: a "previously stable cases" block for the design prompt (experience-tracker). Empty → "". */
export function formatExperience(titles: string[]): string {
  if (titles.length === 0) return "";
  return (
    "Previously STABLE cases for this URL (past runs) — reuse/extend, do NOT duplicate:\n" +
    titles.map((t) => `- ${t}`).join("\n")
  );
}
