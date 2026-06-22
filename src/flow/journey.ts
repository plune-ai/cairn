import { HumanMessage } from "@langchain/core/messages";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import { JourneyResultSchema, type DesignedJourney, type JourneyCase } from "../design/schema.js";
import type { FlowGraph } from "./crawl.js";

/** Distinct page URLs the journey's steps touch. */
const distinctPages = (j: DesignedJourney): number => new Set(j.steps.map((s) => s.page)).size;

/**
 * Per-page grounding (anti-hallucination): each step keeps only the refs that actually exist on
 * THAT step's page. Mirrors `designTestCases` ref filtering, but page-aware for journeys.
 */
export function groundJourney(j: DesignedJourney, refsByPage: Map<string, Set<string>>): DesignedJourney {
  return {
    ...j,
    steps: j.steps.map((s) => ({
      ...s,
      elementRefs: s.elementRefs.filter((r) => (refsByPage.get(s.page) ?? new Set<string>()).has(r)),
    })),
  };
}

export interface JourneyInput {
  graph: FlowGraph;
  /** Case language (default "English"). */
  language?: string;
}

export interface JourneyDeps {
  invoke: StructuredInvoke;
  prompts: PromptRegistry;
}

/**
 * #59 — design multi-page journey cases from the flow graph (reasoner tier). Refs are grounded
 * per page; only journeys that span ≥2 distinct pages survive. Returns [] for a single-node graph
 * (no journey is possible) without calling the LLM.
 */
export async function designJourneys(input: JourneyInput, deps: JourneyDeps): Promise<JourneyCase[]> {
  const { graph } = input;
  if (graph.nodes.length < 2) return []; // a journey needs ≥2 pages

  const refsByPage = new Map(
    graph.nodes.map((n) => [n.url, new Set(n.verified.filter((v) => v.count >= 1).map((v) => v.ref))]),
  );

  const pages = graph.nodes
    .map((n) => {
      const els = n.verified
        .filter((v) => v.interactive && v.count >= 1)
        .map((v) => `  ${v.ref} · ${v.role}${v.name ? ` "${v.name}"` : ""}`)
        .join("\n");
      return `PAGE ${n.url}\n${els || "  (no interactive elements)"}`;
    })
    .join("\n\n");
  const edges =
    graph.edges
      .map((e) => `- ${e.from} --(${e.via.role}${e.via.name ? ` "${e.via.name}"` : ""})--> ${e.to}`)
      .join("\n") || "(no observed transitions)";

  const prompt = await deps.prompts.getPrompt("qa-journey-from-flow", {
    pages,
    edges,
    language: input.language ?? "English",
  });
  const result = await deps.invoke(JourneyResultSchema, [new HumanMessage(prompt.text)]);

  return result.journeys
    .map((j) => groundJourney(j, refsByPage))
    .filter((j) => distinctPages(j) >= 2) // enforce the cross-page invariant
    .map((j, i) => ({ ...j, id: `journey-${i + 1}` }));
}
