import type { FileBlob, GeneratedSuite } from "./schema.js";
import type { JourneyCase } from "../design/schema.js";
import type { FlowGraph } from "../flow/crawl.js";
import type { SetupPlan } from "../flow/setup.js";
import { locatorFor } from "../artifacts/report.js";

/**
 * #60 — render a runnable @playwright/test spec for one journey, with its SETUP established before the
 * steps. Pure + deterministic (no LLM): the setup shape is fixed per strategy, so we emit it directly
 * rather than asking a model. Step assertions are read-only (toBeVisible), refs resolved PER PAGE from
 * the flow graph. Manual preconditions are documented and the test is skipped (clean fallback).
 */
export function renderJourneySetup(
  journey: JourneyCase,
  plan: SetupPlan,
  graph: FlowGraph,
  baseUrl: string,
): FileBlob {
  // ref → locator, resolved within the page the ref belongs to (per-page grounding from #59).
  const byPage = new Map(graph.nodes.map((n) => [n.url, new Map(n.verified.map((v) => [v.ref, v]))]));
  const locator = (page: string, ref: string): string | null => {
    const el = byPage.get(page)?.get(ref);
    return el ? locatorFor(el) : null;
  };
  const esc = (s: string): string => s.replace(/'/g, "");

  const sessions = plan.preconditions.filter((p) => p.strategy === "session");
  const fixtures = plan.preconditions.filter((p) => p.strategy === "fixture");
  const seeds = plan.preconditions.filter((p) => p.strategy === "api-seed");
  const manual = plan.preconditions.filter((p) => p.strategy === "manual");

  const L: string[] = ["import { test, expect } from '@playwright/test';", ""];

  L.push(`// Journey: ${journey.title}`);
  for (const p of plan.preconditions) L.push(`// precondition [${p.strategy}]: ${p.description}`);
  for (const s of sessions) L.push(`// "${s.description}" — satisfied by the captured session (storageState).`);
  L.push("");

  // fixture + api-seed → a beforeEach that establishes the starting state.
  if (fixtures.length > 0 || seeds.length > 0) {
    L.push("test.beforeEach(async ({ page, request }) => {");
    for (const f of fixtures) {
      L.push(`  // setup (fixture): ${f.description}`);
      L.push(`  await page.goto('${baseUrl}');`);
    }
    for (const sd of seeds) {
      const method = (sd.method ?? "POST").toLowerCase();
      L.push(`  // setup (api-seed): ${sd.description}`);
      L.push(`  await request.${method}('${sd.endpoint ?? ""}');`);
    }
    L.push("});", "");
  }

  // Manual preconditions can't be created safely → skip the test, documenting what a human must set up.
  const skip =
    manual.length > 0
      ? `\n  test.skip(true, 'MANUAL precondition(s): ${esc(manual.map((m) => m.description).join("; "))}');`
      : "";

  L.push(`test('${esc(journey.title)}', async ({ page }) => {${skip}`);
  let prevPage = "";
  for (const step of journey.steps) {
    L.push(`  await test.step(${JSON.stringify(step.action)}, async () => {`);
    if (step.page !== prevPage) {
      L.push(`    await page.goto('${step.page}');`);
      prevPage = step.page;
    }
    for (const ref of step.elementRefs) {
      const loc = locator(step.page, ref);
      if (loc) L.push(`    await expect(${loc}).toBeVisible();`); // read-only across the whole journey
    }
    L.push("  });");
  }
  L.push("});", "");

  return { path: `journeys/${journey.id}.spec.ts`, content: L.join("\n") };
}

/** Map journeys + their setup plans → a @playwright/test suite (one spec per journey). */
export function buildJourneySetupSuite(
  journeys: JourneyCase[],
  plans: SetupPlan[],
  graph: FlowGraph,
  baseUrl: string,
): GeneratedSuite {
  return {
    files: journeys.map((j, i) => renderJourneySetup(j, plans[i] ?? { preconditions: [] }, graph, baseUrl)),
  };
}
