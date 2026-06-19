import { describe, it, expect } from "vitest";
import { deterministicScores } from "../../src/eval/scorers.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { VerifiedElement } from "../../src/browser/types.js";
import type { TestCase } from "../../src/design/index.js";

const study: PageStudy = { url: "http://x", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] };

const verified: VerifiedElement[] = [
  { ref: "e1", role: "button", name: "Go", interactive: true, rank: 3, count: 1, verified: true },
  { ref: "e2", role: "link", name: "X", interactive: true, rank: 3, count: 0, verified: false },
];

const testCases: TestCase[] = [
  { id: "tc-1", title: "A", technique: "exploratory", preconditions: [], steps: ["s"], expected: "e", priority: "high", elementRefs: ["e1"] },
  { id: "tc-2", title: "B", technique: "exploratory", preconditions: [], steps: ["s"], expected: "e", priority: "low", elementRefs: ["e2"] },
];

function byName(scores: { name: string; value: number }[], name: string): number | undefined {
  return scores.find((s) => s.name === name)?.value;
}

describe("deterministicScores", () => {
  it("computes runs_green, verified_ratio, grounding, locator_quality, flaky_ratio", () => {
    const scores = deterministicScores({
      study,
      verified,
      testCases,
      suite: {
        files: [
          {
            path: "a.spec.ts",
            content: "page.getByRole('button'); page.getByLabel('x'); page.locator('#css');",
          },
        ],
      },
      validation: {
        results: [
          { test: "a", status: "passed" },
          { test: "b", status: "failed" },
        ],
        greenRatio: 0.5,
        flakyCount: 0,
      },
    });
    expect(byName(scores, "runs_green")).toBe(0.5);
    expect(byName(scores, "verified_ratio")).toBe(0.5); // 1/2 verified
    expect(byName(scores, "grounding")).toBe(0.5); // tc-1 grounded (e1), tc-2 not (e2 unverified)
    expect(byName(scores, "locator_quality")).toBeCloseTo(2 / 3, 5); // 2 user-facing vs 1 css/testid
    expect(byName(scores, "locator_robustness")).toBeCloseTo(1.8 / 3, 5); // role 1 + label .8 + css 0 over 3
    expect(byName(scores, "flaky_ratio")).toBe(0);
  });

  it("locator_robustness counts xpath/positional action selectors against robustness", () => {
    const scores = deterministicScores({
      study,
      verified,
      testCases,
      suite: { files: [{ path: "x.spec.ts", content: "await page.click('xpath=//button');" }] },
    });
    expect(byName(scores, "locator_robustness")).toBe(0); // xpath= → css tier (weight 0)
  });

  it("without validation/suite — skips the corresponding scores, does not crash", () => {
    const scores = deterministicScores({ study, verified, testCases });
    expect(byName(scores, "runs_green")).toBeUndefined();
    expect(byName(scores, "grounding")).toBe(0.5);
  });

  it("technique_coverage and case_redundancy (#58)", () => {
    const mk = (over: Partial<(typeof testCases)[number]>) => ({
      id: "x", title: "t", technique: "boundary-value", type: "Positive",
      preconditions: [], steps: ["enter 0"], expected: "e", priority: "high", elementRefs: ["e1"],
      ...over,
    });
    const cases = [
      mk({ id: "1" }),
      mk({ id: "2" }), // near-dup of 1
      mk({ id: "3", technique: "equivalence-partitioning", elementRefs: ["e9"], steps: ["other"] }),
    ];
    const scores = deterministicScores({ study, verified, testCases: cases as never, suite: undefined, validation: undefined });
    expect(byName(scores, "technique_coverage")).toBeCloseTo(2 / 6, 5); // boundary-value + equivalence-partitioning
    expect(byName(scores, "case_redundancy")).toBeCloseTo(2 / 3, 5); // cases 1 & 2 near-dup → 2 of 3
  });
});
