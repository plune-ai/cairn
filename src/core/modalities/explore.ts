/**
 * C1-01 — the `explore` modality: the first REAL modality consuming the shared core.
 *
 * It wraps {@link runExploration} plus the shared render/cost/summary helpers (resolveConfig +
 * printCost + renderRunSummary). The CLI `explore` command is now a thin delegate to this `run`,
 * so its output is identical to the pre-extraction inline action (locked by the C1-02 parity test).
 */
import { readFile } from "node:fs/promises";
import { runExploration } from "../../agent/index.js";
import { renderRunSummary } from "../../agent/summary.js";
import { resolveConfig } from "../config.js";
import { printCost } from "../reporting.js";
import type { Modality, ModalityContext } from "../modality.js";

/** Parsed flags for `cairn explore` (mirrors the command's option definitions). */
interface ExploreFlags {
  url: string;
  backend?: string;
  session?: string;
  sessionFile?: string;
  headed?: boolean;
  checklist?: string;
  style?: string;
  routing?: string;
}

export const exploreModality: Modality = {
  name: "explore",
  gated: false,
  summary: "Explore a page and generate methodology-based UI test cases (validate ⇄ repair)",
  async run(ctx: ModalityContext): Promise<void> {
    // commander hands the action untyped options; the command's option defs guarantee this shape.
    const opts = ctx.flags as unknown as ExploreFlags;
    const config = resolveConfig({ backend: opts.backend, routing: opts.routing });
    const checklistText = opts.checklist ? await readFile(opts.checklist, "utf8") : undefined;
    ctx.err(
      `▸ Exploring ${opts.url}${opts.session ? ` (session: ${opts.session})` : ""}${opts.checklist ? ` (checklist: ${opts.checklist})` : ""}…\n`,
    );
    const result = await runExploration({
      url: opts.url,
      config,
      sessionName: opts.session,
      sessionFile: opts.sessionFile,
      headed: opts.headed,
      checklistText,
      style: opts.style,
      onProgress: (e) => ctx.err(`  ▸ ${e}\n`),
    });

    ctx.out(`\n=== Exploration of ${result.study.url} (run ${result.runId}) ===\n`);
    ctx.out(`Purpose: ${result.analysis.pageSemantics}\n`);
    ctx.out(`LLM profile: ${config.llmProfile} · test cases: ${result.testCases.length}\n\n`);
    for (const tc of result.testCases) {
      ctx.out(`[${tc.id}] (${tc.priority} · ${tc.technique}) ${tc.title}\n`);
      for (const step of tc.steps) ctx.out(`    - ${step}\n`);
      ctx.out(`    ⇒ ${tc.expected}\n`);
      if (tc.elementRefs.length) ctx.out(`    refs: ${tc.elementRefs.join(", ")}\n`);
      ctx.out("\n");
    }

    if (result.validation) {
      const v = result.validation;
      ctx.out(`=== Validation: ${Math.round(v.greenRatio * 100)}% green (flaky: ${v.flakyCount}) ===\n`);
      for (const r of v.results) {
        const mark = r.status === "passed" ? "✓" : r.status === "flaky" ? "~" : "✗";
        ctx.out(`  ${mark} ${r.test}\n`);
      }
    }
    if (result.scores.length > 0) {
      ctx.out("\n=== Metrics ===\n");
      for (const s of result.scores) {
        ctx.out(`  ${s.name}: ${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""}\n`);
      }
    }
    if (result.pilot) {
      ctx.out(
        `\n=== Pilot: ${result.pilot.verdict.toUpperCase()} ===\n  ${result.pilot.reason}\n  → ${result.pilot.guidance}\n`,
      );
    }
    printCost(result.cost, ctx.out);
    // L1-04 (Box 4): one unambiguous footer — pass/fail · cost+tokens · budget used · artifact path.
    ctx.out("\n");
    for (const line of renderRunSummary({
      runDir: result.runDir,
      validation: result.validation,
      cost: result.cost,
      budget: result.budget,
      testCaseCount: result.testCases.length,
      stoppedEarly: result.stoppedEarly,
    })) {
      ctx.out(`${line}\n`);
    }
    // #39: explore now also writes ATC/MTC cases, and points at the review-first flow for next time.
    if (result.testCaseFiles.length > 0) {
      ctx.out(`  Cases (ATC/MTC .md): ${result.runDir}\\testcases\\\n`);
    }
    ctx.out(
      "\nTip: to review cases BEFORE generating code, run `cairn design` then `cairn automate`.\n",
    );
  },
};
