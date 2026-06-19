import type { TestCase } from "./schema.js";

export interface DuplicateGroup {
  representative: TestCase;
  duplicates: TestCase[];
  reason: "merged" | "flagged";
}

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ");
const stepSet = (steps: string[]): Set<string> => new Set(steps.map(norm));
const refsKey = (refs: string[]): string => [...refs].sort().join("|");

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Single source of truth for "near-duplicate". Shared by dedupCases and the case_redundancy scorer. */
export function caseSimilarity(a: TestCase, b: TestCase): "merge" | "flag" | "distinct" {
  if (a.technique !== b.technique || a.type !== b.type) return "distinct";
  const sameRefs = refsKey(a.elementRefs) === refsKey(b.elementRefs);
  if (sameRefs && jaccard(stepSet(a.steps), stepSet(b.steps)) >= 0.9) return "merge";
  const aSet = new Set(a.elementRefs);
  const overlap = b.elementRefs.some((r) => aSet.has(r));
  if ((overlap && !sameRefs) || (norm(a.title) === norm(b.title) && !sameRefs)) return "flag";
  return "distinct";
}

/** Better representative: higher priority, then more steps, then the earlier one (a). */
function better(a: TestCase, b: TestCase): TestCase {
  const pa = PRIORITY_RANK[a.priority] ?? 0;
  const pb = PRIORITY_RANK[b.priority] ?? 0;
  if (pa !== pb) return pa > pb ? a : b;
  if (a.steps.length !== b.steps.length) return a.steps.length > b.steps.length ? a : b;
  return a;
}

/** Tiered dedup: merge high-confidence dups (keep best rep), flag borderline (kept, counted). */
export function dedupCases(cases: TestCase[]): { merged: TestCase[]; flagged: DuplicateGroup[] } {
  const reps: TestCase[] = [];
  const flagged: DuplicateGroup[] = [];
  for (const c of cases) {
    let mergedIn = false;
    for (let k = 0; k < reps.length; k += 1) {
      if (caseSimilarity(reps[k]!, c) === "merge") {
        const winner = better(reps[k]!, c);
        const loser = winner === reps[k]! ? c : reps[k]!;
        flagged.push({ representative: winner, duplicates: [loser], reason: "merged" });
        reps[k] = winner;
        mergedIn = true;
        break;
      }
    }
    if (!mergedIn) {
      for (const r of reps) {
        if (caseSimilarity(r, c) === "flag") flagged.push({ representative: r, duplicates: [c], reason: "flagged" });
      }
      reps.push(c);
    }
  }
  return { merged: reps, flagged };
}
