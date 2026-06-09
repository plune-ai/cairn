import type { PageStudy } from "../observe/index.js";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { VerifiedElement } from "../browser/types.js";
import { designTestCases } from "../design/index.js";
import { deterministicScores } from "./scorers.js";
import { judgeTestCases } from "./judge.js";

/** A dataset item for an experiment (a pre-captured observation). */
export interface DatasetItem {
  id: string;
  study: PageStudy;
  pageSemantics: string;
  verified?: VerifiedElement[];
}

/** A prompt version to compare (same invoke, different PromptRegistry). */
export interface Variant {
  label: string;
  prompts: PromptRegistry;
}

export interface ExperimentDeps {
  designInvoke: StructuredInvoke;
  judgeInvoke?: StructuredInvoke;
}

export interface VariantResult {
  label: string;
  meanScores: Record<string, number>;
  itemCount: number;
}

export interface ExperimentVerdict {
  target: string;
  baseline: string;
  candidate: string;
  delta: number;
  improved: boolean;
  guardrailRegressions: string[];
}

export interface ExperimentResult {
  perVariant: VariantResult[];
  verdict?: ExperimentVerdict;
}

export interface ExperimentOptions {
  target?: string;
  threshold?: number;
  tolerance?: number;
  guardrails?: string[];
}

/**
 * Run dataset × prompt versions through the design stage, average the metrics, and produce a verdict
 * (B2 self-improvement). A verdict is produced only for two variants: baseline (first) vs candidate (second).
 */
export async function runExperiment(
  items: DatasetItem[],
  variants: Variant[],
  deps: ExperimentDeps,
  opts: ExperimentOptions = {},
): Promise<ExperimentResult> {
  const perVariant: VariantResult[] = [];

  for (const variant of variants) {
    const collected: Record<string, number[]> = {};
    for (const item of items) {
      const verified =
        item.verified ?? item.study.elements.map((e) => ({ ...e, count: 1, verified: true }));
      const testCases = await designTestCases(
        {
          study: item.study,
          pageSemantics: item.pageSemantics,
          elements: verified.filter((v) => v.verified),
        },
        { invoke: deps.designInvoke, prompts: variant.prompts },
      );
      const scores = deterministicScores({ study: item.study, verified, testCases });
      if (deps.judgeInvoke) {
        scores.push(
          ...(await judgeTestCases(testCases, item.pageSemantics, deps.judgeInvoke, variant.prompts)),
        );
      }
      for (const s of scores) (collected[s.name] ??= []).push(s.value);
    }

    const meanScores: Record<string, number> = {};
    for (const [name, vals] of Object.entries(collected)) {
      meanScores[name] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    perVariant.push({ label: variant.label, meanScores, itemCount: items.length });
  }

  let verdict: ExperimentVerdict | undefined;
  const base = perVariant[0];
  const cand = perVariant[1];
  if (perVariant.length === 2 && base && cand) {
    const target = opts.target ?? "grounding";
    const threshold = opts.threshold ?? 0.05;
    const tolerance = opts.tolerance ?? 0.02;
    const guardrails = opts.guardrails ?? [
      "grounding",
      "test_case_quality",
      "methodology_adherence",
      "locator_quality",
    ];
    const delta = (cand.meanScores[target] ?? 0) - (base.meanScores[target] ?? 0);
    const guardrailRegressions = guardrails.filter((g) => {
      if (g === target) return false;
      const b = base.meanScores[g];
      const c = cand.meanScores[g];
      if (b === undefined || c === undefined) return false;
      return c < b - tolerance;
    });
    verdict = {
      target,
      baseline: base.label,
      candidate: cand.label,
      delta,
      improved: delta >= threshold && guardrailRegressions.length === 0,
      guardrailRegressions,
    };
  }

  return { perVariant, verdict };
}
