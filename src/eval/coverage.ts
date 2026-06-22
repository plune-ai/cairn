import type { VerifiedElement } from "../browser/types.js";
import type { TestCase, JourneyCase } from "../design/schema.js";
import type { FlowEdge } from "../flow/crawl.js";

/** One observed-but-untested interactive element, with a short reason it matters. */
export interface CoverageGap {
  page: string;
  ref: string;
  role: string;
  name?: string;
  /** Why leaving this untested is a risk (role-derived). */
  why: string;
}

export interface PageCoverage {
  url: string;
  observed: number;
  covered: number;
  gaps: CoverageGap[];
}

export interface CoverageReport {
  /** Total observed interactive elements across all pages. */
  observed: number;
  /** How many of them are referenced by at least one case/journey. */
  covered: number;
  /** covered / observed (1 when there is nothing to miss). */
  ratio: number;
  byPage: PageCoverage[];
  /** Observed transitions no journey walks end-to-end. */
  untestedEdges: FlowEdge[];
}

export interface CoverageInput {
  /** Observed surface per page (verified interactive elements). */
  pages: { url: string; elements: VerifiedElement[] }[];
  /** Observed transitions between pages (#59). */
  edges: FlowEdge[];
  /** Per-page cases (their elementRefs count as coverage). */
  testCases: TestCase[];
  /** Journey cases (their per-step elementRefs + page sequence count as coverage). */
  journeys?: JourneyCase[];
}

/** Role-derived "why it matters" for an untested control. */
function whyMatters(role: string): string {
  switch (role) {
    case "button":
      return "actionable control never exercised — its behavior is untested";
    case "link":
      return "navigation path not covered — a route may be broken and unnoticed";
    case "textbox":
    case "searchbox":
    case "combobox":
    case "spinbutton":
      return "input field never validated — accepts/rejects untested";
    case "checkbox":
    case "radio":
    case "switch":
      return "state toggle not checked — on/off behavior untested";
    case "tab":
    case "menuitem":
      return "view/menu entry not opened — its content is unverified";
    default:
      return "interactive element with no test referencing it";
  }
}

/**
 * #61 — coverage = observed interactive surface + observed edges MINUS what any case/journey references.
 * Pure set-difference (no LLM, no I/O), grouped by page. `ratio` is 1 when there is nothing observed,
 * so it never produces NaN. Reconciles with the grounding/technique metrics (same verified refs).
 */
export function computeCoverage(input: CoverageInput): CoverageReport {
  const coveredRefs = new Set<string>([
    ...input.testCases.flatMap((c) => c.elementRefs),
    ...(input.journeys ?? []).flatMap((j) => j.steps.flatMap((s) => s.elementRefs)),
  ]);

  let observed = 0;
  let covered = 0;
  const byPage: PageCoverage[] = input.pages.map((p) => {
    const interactive = p.elements.filter((e) => e.interactive && e.count >= 1);
    const gaps: CoverageGap[] = [];
    let pageCovered = 0;
    for (const e of interactive) {
      if (coveredRefs.has(e.ref)) pageCovered += 1;
      else gaps.push({ page: p.url, ref: e.ref, role: e.role, name: e.name, why: whyMatters(e.role) });
    }
    observed += interactive.length;
    covered += pageCovered;
    return { url: p.url, observed: interactive.length, covered: pageCovered, gaps };
  });

  // An edge is covered when some journey walks from→to on consecutive steps.
  const walked = new Set<string>();
  for (const j of input.journeys ?? []) {
    for (let i = 0; i + 1 < j.steps.length; i += 1) {
      walked.add(`${j.steps[i]!.page}|${j.steps[i + 1]!.page}`);
    }
  }
  const untestedEdges = input.edges.filter((e) => !walked.has(`${e.from}|${e.to}`));

  return { observed, covered, ratio: observed === 0 ? 1 : covered / observed, byPage, untestedEdges };
}
