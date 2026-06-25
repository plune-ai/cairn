/**
 * C1-01 — the `explore` modality: the first REAL modality consuming the shared core.
 *
 * It wraps {@link runExploration} plus the shared render/cost/summary helpers (resolveConfig +
 * printCost + renderRunSummary). The CLI `explore` command is now a thin delegate to this `run`,
 * so its output is identical to the pre-extraction inline action (locked by the C1-02 parity test).
 */
import { readInputFile } from "../../fs/run-dir.js";
import { runExploration } from "../../agent/index.js";
import { resolveStyleText } from "../../design/style.js";
import { renderRunSummary, displayPath } from "../../agent/summary.js";
import { resolveConfig } from "../config.js";
import { printCost } from "../reporting.js";
import { makeCliProgress } from "../progress.js";
import { dirGlyph } from "../../eval/legend.js";
import type { Modality, ModalityContext } from "../modality.js";

/** Parsed flags for `cairn explore` (mirrors the command's option definitions). */
interface ExploreFlags {
  url: string;
  backend?: string;
  channel?: string;
  session?: string;
  sessionFile?: string;
  headed?: boolean;
  checklist?: string;
  style?: string;
  routing?: string;
  fresh?: boolean;
  critique?: boolean;
  flow?: boolean;
  maxPages?: string;
  setup?: boolean;
  gaps?: boolean;
  intoProject?: boolean | string;
}

export const exploreModality: Modality = {
  name: "explore",
  gated: false,
  summary: "Explore a page and generate methodology-based UI test cases (validate ⇄ repair)",
  async run(ctx: ModalityContext): Promise<void> {
    // commander hands the action untyped options; the command's option defs guarantee this shape.
    const opts = ctx.flags as unknown as ExploreFlags;
    const config = resolveConfig({ backend: opts.backend, routing: opts.routing, channel: opts.channel });
    const checklistText = opts.checklist ? await readInputFile(opts.checklist, "Checklist") : undefined;
    // #80: --style resolves to a house-style pack (prompts/styles/<v>.md or a path) → {{style}} slot,
    // else the built-in inline hint. Methodology / assertion-safety are never touched.
    const styleText = await resolveStyleText(opts.style);
    ctx.err(
      `▸ Exploring ${opts.url}${opts.session ? ` (session: ${opts.session})` : ""}${opts.checklist ? ` (checklist: ${opts.checklist})` : ""}…\n`,
    );
    // Progress UX: animate the current step in a TTY (long LLM steps emit no events for ~a minute, so the
    // CLI looked frozen). In a pipe/CI this falls back to one plain `  ▸ <event>` line per event.
    const progress = makeCliProgress({ write: ctx.err, isTTY: Boolean(ctx.isTTY), now: Date.now });
    const result = await runExploration({
      url: opts.url,
      config,
      sessionName: opts.session,
      sessionFile: opts.sessionFile,
      headed: opts.headed,
      checklistText,
      style: opts.style,
      styleText,
      fresh: opts.fresh,
      critique: opts.critique,
      flow: opts.flow,
      maxPages: opts.flow ? Number(opts.maxPages) || 3 : undefined,
      setup: opts.setup,
      gaps: opts.gaps,
      intoProject: opts.intoProject !== undefined && opts.intoProject !== false,
      projectDir: typeof opts.intoProject === "string" ? opts.intoProject : undefined,
      onProgress: progress.event,
    }).finally(() => progress.stop());

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
      ctx.out("\n=== Metrics ===  (↑ higher is better · ↓ lower is better)\n");
      for (const s of result.scores) {
        const g = dirGlyph(s.name);
        ctx.out(`  ${s.name}${g ? ` ${g}` : ""}: ${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""}\n`);
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
      ctx.out(`  Cases (ATC/MTC .md): ${displayPath(result.runDir)}/testcases/\n`);
    }
    // #51: when ejected into an existing Playwright project, show WHERE the runnable specs landed.
    if (result.projectTestDir && result.projectSpecFiles?.length) {
      ctx.out(
        `  Specs → project: ${result.projectSpecFiles.length} file(s) in ${displayPath(result.projectTestDir)} (run with your project's \`npx playwright test\`)\n`,
      );
    }
    ctx.out(
      "\nTip: to review cases BEFORE generating code, run `cairn design` then `cairn automate`.\n",
    );
  },
};
