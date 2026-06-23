import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import { DesignedCaseSchema, TestTechniqueSchema, type TestCase } from "./schema.js";
import { dedupCases } from "./dedup.js";

/** The 6 × ISO/IEC/IEEE 29119-4 techniques (single source: the schema enum). */
const ALL_TECHNIQUES = TestTechniqueSchema.options;

/** What the critique pass changed — recorded in report.json next to technique_coverage / case_redundancy. */
export interface CritiqueDelta {
  /** Case count before the pass. */
  before: number;
  /** Case count after the pass (prune + top-up + re-dedup). */
  after: number;
  /** Cases dropped as trivial / contradictory / unverifiable. */
  pruned: number;
  /** Titles of the dropped cases (so the report shows WHAT was pruned). */
  prunedTitles: string[];
  /** New cases the top-up proposed (grounded against real refs). */
  toppedUp: number;
  /** technique_coverage (distinct/6) before the pass. */
  techniqueCoverageBefore: number;
  /** technique_coverage (distinct/6) after the pass. */
  techniqueCoverageAfter: number;
  /** Techniques newly covered by the top-up. */
  techniquesAdded: string[];
}

export interface CritiqueInput {
  testCases: TestCase[];
  pageSemantics: string;
  /** Real element refs (count≥1) — top-up cases are grounded against these (anti-hallucination). */
  knownRefs: string[];
  /** Case language (default "English"). */
  language?: string;
}

export interface CritiqueDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
}

/** What the worker returns: which cases to drop + which new cases to add. */
export const CritiqueResultSchema = z.object({
  drop: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
  add: z.array(DesignedCaseSchema).default([]),
});

const distinctTechniques = (cases: TestCase[]): Set<string> => new Set(cases.map((c) => c.technique));

/**
 * #82 — design-time self-critique: ONE cheap worker-tier pass AFTER the first design set and BEFORE
 * finalization. It (a) prunes trivial / contradictory / unverifiable cases and (b) tops up techniques
 * under-represented across the 6 × 29119-4 set. Methodology and assertion-safety rules are unchanged —
 * this only prunes and fills gaps. Top-up refs are grounded exactly like {@link designTestCases}.
 */
export async function critiqueCases(
  input: CritiqueInput,
  deps: CritiqueDeps,
): Promise<{ cases: TestCase[]; delta: CritiqueDelta }> {
  const before = input.testCases;
  const techBefore = distinctTechniques(before);
  const underrepresented = ALL_TECHNIQUES.filter((t) => !techBefore.has(t));

  const casesList = before
    .map((c) => `- ${c.id} [${c.technique}/${c.type}] ${c.title} → expected: ${c.expected}`)
    .join("\n");
  const prompt = await deps.prompts.getPrompt("qa-case-critique", {
    cases: casesList,
    underrepresented: underrepresented.join(", ") || "(none — all 6 techniques already covered)",
    elements: input.knownRefs.join(", "),
    language: input.language ?? "English",
  });
  const result = await deps.invoke(CritiqueResultSchema, [new HumanMessage(prompt.text)]);

  const dropIds = new Set(result.drop.map((d) => d.id));
  const prunedTitles = before.filter((c) => dropIds.has(c.id)).map((c) => c.title);
  const kept = before.filter((c) => !dropIds.has(c.id));

  // Ground top-up refs against real elements (same anti-hallucination rule as designTestCases).
  const known = new Set(input.knownRefs);
  const toppedUpCases = result.add.map((c) => ({
    ...c,
    id: "tc-pending",
    elementRefs: c.elementRefs.filter((r) => known.has(r)),
  }));

  // Re-id + re-dedup the combined set, mirroring designTestCases' tail (one source of truth for dedup).
  const combined = [...kept, ...toppedUpCases].map((c, i) => ({ ...c, id: `tc-${i + 1}` }));
  const after = dedupCases(combined).merged;

  const techAfter = distinctTechniques(after);
  const techniquesAdded = [...techAfter].filter((t) => !techBefore.has(t));

  return {
    cases: after,
    delta: {
      before: before.length,
      after: after.length,
      pruned: prunedTitles.length,
      prunedTitles,
      toppedUp: toppedUpCases.length,
      techniqueCoverageBefore: techBefore.size / ALL_TECHNIQUES.length,
      techniqueCoverageAfter: techAfter.size / ALL_TECHNIQUES.length,
      techniquesAdded,
    },
  };
}
