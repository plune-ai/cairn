import { describe, it, expect } from "vitest";
import { computeCoverage } from "../../src/eval/coverage.js";
import type { VerifiedElement } from "../../src/browser/types.js";
import type { TestCase, JourneyCase } from "../../src/design/schema.js";

const el = (ref: string, role: string, name: string): VerifiedElement => ({
  ref,
  role,
  name,
  interactive: true,
  rank: 3,
  count: 1,
  verified: true,
});

const tc = (id: string, refs: string[]): TestCase => ({
  id,
  title: id,
  technique: "exploratory",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["s"],
  expected: "e",
  priority: "medium",
  elementRefs: refs,
});

describe("computeCoverage (#61)", () => {
  it("set-difference: observed interactive surface MINUS refs used by cases = gaps", () => {
    const page = {
      url: "http://app/p1",
      elements: [el("e1", "button", "Save"), el("e2", "textbox", "Email"), el("e3", "link", "Docs")],
    };
    const cov = computeCoverage({ pages: [page], edges: [], testCases: [tc("tc-1", ["e1"])], journeys: [] });

    expect(cov.observed).toBe(3);
    expect(cov.covered).toBe(1);
    expect(cov.ratio).toBeCloseTo(1 / 3);
    const gaps = cov.byPage[0]!.gaps.map((g) => g.ref).sort();
    expect(gaps).toEqual(["e2", "e3"]); // e1 covered, e2/e3 are gaps
    // each gap carries a non-empty "why it matters"
    expect(cov.byPage[0]!.gaps.every((g) => g.why.length > 0)).toBe(true);
  });

  it("journey step refs also count as coverage (reconciles per-page + journey)", () => {
    const page = { url: "http://app/p1", elements: [el("e1", "button", "Save"), el("e2", "textbox", "Email")] };
    const journey: JourneyCase = {
      id: "journey-1",
      title: "j",
      technique: "state-transition",
      type: "Positive",
      preconditions: [],
      steps: [{ page: "http://app/p1", action: "fill", elementRefs: ["e2"] }],
      expected: "ok",
      priority: "high",
    };
    const cov = computeCoverage({ pages: [page], edges: [], testCases: [tc("tc-1", ["e1"])], journeys: [journey] });
    expect(cov.covered).toBe(2); // e1 by case, e2 by journey
    expect(cov.byPage[0]!.gaps).toHaveLength(0);
  });

  it("flags observed transitions/edges not traversed by any journey", () => {
    const pages = [
      { url: "http://app/p1", elements: [el("e1", "link", "Next")] },
      { url: "http://app/p2", elements: [el("e9", "heading", "P2")] },
    ];
    const edges = [{ from: "http://app/p1", to: "http://app/p2", via: { ref: "e1", role: "link", name: "Next" } }];

    // no journey traverses the edge → it's an untested transition
    const cov1 = computeCoverage({ pages, edges, testCases: [], journeys: [] });
    expect(cov1.untestedEdges).toHaveLength(1);

    // a journey that goes p1 → p2 covers the edge
    const journey: JourneyCase = {
      id: "journey-1",
      title: "j",
      technique: "state-transition",
      type: "Positive",
      preconditions: [],
      steps: [
        { page: "http://app/p1", action: "click Next", elementRefs: ["e1"] },
        { page: "http://app/p2", action: "see p2", elementRefs: ["e9"] },
      ],
      expected: "p2 visible",
      priority: "high",
    };
    const cov2 = computeCoverage({ pages, edges, testCases: [], journeys: [journey] });
    expect(cov2.untestedEdges).toHaveLength(0);
  });

  it("no observed surface → ratio 1 (nothing to miss), no NaN", () => {
    const cov = computeCoverage({ pages: [{ url: "http://app/x", elements: [] }], edges: [], testCases: [], journeys: [] });
    expect(cov.observed).toBe(0);
    expect(cov.ratio).toBe(1);
  });
});
