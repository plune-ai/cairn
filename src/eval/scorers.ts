import type { PageStudy } from "../observe/index.js";
import type { TestCase } from "../design/index.js";
import type { GeneratedSuite } from "../codegen/index.js";
import type { ValidationReport } from "../validate/index.js";
import type { VerifiedElement } from "../browser/types.js";
import { caseSimilarity } from "../design/dedup.js";

export interface Score {
  name: string;
  value: number;
  comment?: string;
}

export interface ScoreInput {
  study: PageStudy;
  verified: VerifiedElement[];
  testCases: TestCase[];
  suite?: GeneratedSuite;
  validation?: ValidationReport;
}

/**
 * Deterministic (objective) scorers — computed from run data without an LLM or network.
 * Foundation of the self-improvement loop: a measurable signal for every run (ADR-0006).
 */
export function deterministicScores(input: ScoreInput): Score[] {
  const scores: Score[] = [];

  if (input.validation) {
    scores.push({ name: "runs_green", value: input.validation.greenRatio });
    if (input.validation.results.length > 0) {
      scores.push({
        name: "flaky_ratio",
        value: input.validation.flakyCount / input.validation.results.length,
      });
    }
  }

  if (input.verified.length > 0) {
    const ok = input.verified.filter((v) => v.verified).length;
    scores.push({ name: "verified_ratio", value: ok / input.verified.length });
  }

  // grounding: share of cases whose elementRefs all point to REAL elements (count≥1),
  // including duplicated ones (.first()). verified_ratio separately measures uniqueness (count===1).
  const realRefs = new Set(input.verified.filter((v) => v.count >= 1).map((v) => v.ref));
  if (input.testCases.length > 0) {
    const grounded = input.testCases.filter(
      (tc) => tc.elementRefs.length > 0 && tc.elementRefs.every((r) => realRefs.has(r)),
    ).length;
    scores.push({ name: "grounding", value: grounded / input.testCases.length });
  }

  // locator_quality: share of user-facing locators vs CSS/testid in the generated code.
  if (input.suite) {
    const code = input.suite.files.map((f) => f.content).join("\n");
    const userFacing = (code.match(/getBy(Role|Label|Text|Placeholder|AltText|Title)/g) ?? []).length;
    const fragile = (code.match(/\.locator\(|getByTestId|page\.\$/g) ?? []).length;
    const total = userFacing + fragile;
    if (total > 0) scores.push({ name: "locator_quality", value: userFacing / total });
  }

  // technique_coverage (#58): breadth across the 6 ISO/IEC/IEEE 29119-4 techniques.
  if (input.testCases.length > 0) {
    const techniques = new Set(input.testCases.map((c) => c.technique));
    scores.push({ name: "technique_coverage", value: techniques.size / 6 });
  }
  // case_redundancy (#58): share of cases in >=1 near-duplicate pair (shared caseSimilarity — DRY).
  if (input.testCases.length > 1) {
    const involved = new Set<number>();
    for (let i = 0; i < input.testCases.length; i += 1) {
      for (let j = i + 1; j < input.testCases.length; j += 1) {
        if (caseSimilarity(input.testCases[i]!, input.testCases[j]!) !== "distinct") {
          involved.add(i);
          involved.add(j);
        }
      }
    }
    scores.push({ name: "case_redundancy", value: involved.size / input.testCases.length });
  }

  return scores;
}
