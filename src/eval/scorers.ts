import type { PageStudy } from "../observe/index.js";
import type { TestCase } from "../design/index.js";
import type { GeneratedSuite } from "../codegen/index.js";
import type { ValidationReport } from "../validate/index.js";
import type { VerifiedElement } from "../browser/types.js";

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

  return scores;
}
