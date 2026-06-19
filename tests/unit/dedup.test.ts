import { describe, it, expect } from "vitest";
import { caseSimilarity, dedupCases } from "../../src/design/dedup.js";
import type { TestCase } from "../../src/design/schema.js";

const tc = (over: Partial<TestCase>): TestCase => ({
  id: "x", title: "t", technique: "exploratory", type: "Positive", kind: "active",
  execution: "auto", preconditions: [], steps: ["a"], expected: "e", priority: "medium",
  elementRefs: [], ...over,
});

describe("caseSimilarity", () => {
  it("merge: same technique+type, identical refs, near-identical steps", () => {
    const a = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    const b = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    expect(caseSimilarity(a, b)).toBe("merge");
  });
  it("distinct: different technique on the same field (diversity protected)", () => {
    const a = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    const b = tc({ technique: "equivalence-partitioning", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    expect(caseSimilarity(a, b)).toBe("distinct");
  });
  it("distinct: Positive vs Negative never merge", () => {
    const a = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    const b = tc({ technique: "boundary-value", type: "Negative", elementRefs: ["e1"], steps: ["enter 0"] });
    expect(caseSimilarity(a, b)).toBe("distinct");
  });
  it("flag: same technique+type, overlapping but not identical refs, different steps", () => {
    const a = tc({ technique: "exploratory", type: "Positive", elementRefs: ["e1", "e2"], steps: ["click a"] });
    const b = tc({ technique: "exploratory", type: "Positive", elementRefs: ["e2", "e3"], steps: ["click b totally different"] });
    expect(caseSimilarity(a, b)).toBe("flag");
  });
});

describe("dedupCases", () => {
  it("merges high-confidence dups, keeping the higher-priority representative", () => {
    const a = tc({ id: "tc-1", priority: "low", technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["click x"] });
    const b = tc({ id: "tc-2", priority: "critical", technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["click x"] });
    const { merged, flagged } = dedupCases([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("tc-2"); // critical beats low
    expect(flagged.some((g) => g.reason === "merged")).toBe(true);
  });
  it("keeps borderline pairs (flagged, not dropped)", () => {
    const a = tc({ id: "tc-1", technique: "exploratory", type: "Positive", elementRefs: ["e1", "e2"], steps: ["click a"] });
    const b = tc({ id: "tc-2", technique: "exploratory", type: "Positive", elementRefs: ["e2", "e3"], steps: ["click b totally different"] });
    const { merged, flagged } = dedupCases([a, b]);
    expect(merged).toHaveLength(2);
    expect(flagged.some((g) => g.reason === "flagged")).toBe(true);
  });
  it("leaves distinct cases untouched; 0/1 case is a no-op", () => {
    expect(dedupCases([]).merged).toHaveLength(0);
    const a = tc({ technique: "boundary-value", elementRefs: ["e1"] });
    expect(dedupCases([a]).merged).toHaveLength(1);
    const b = tc({ technique: "state-transition", elementRefs: ["e9"] });
    expect(dedupCases([a, b]).merged).toHaveLength(2);
  });
});
