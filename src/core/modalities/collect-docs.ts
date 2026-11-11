/**
 * #24 — the `collect-docs` modality (alias `docs`): walk the app and write its user docs as Markdown.
 * The work is `runCollectDocs` (`agent/collect-docs.ts`); this is the CLI glue: flags → config, progress, the summary.
 */
import { runCollectDocs, DEFAULT_MAX_SCREENS } from "../../agent/collect-docs.js";
import { displayPath } from "../../agent/summary.js";
import { resolveConfig } from "../config.js";
import { printCost } from "../reporting.js";
import { makeCliProgress } from "../progress.js";
import type { Modality, ModalityContext } from "../modality.js";

/** Parsed flags for `cairn collect-docs` (mirrors the command's option definitions). */
interface CollectDocsFlags {
  url: string;
  session?: string;
  sessionFile?: string;
  channel?: string;
  headed?: boolean;
  maxPages?: string;
  out?: string;
  fresh?: boolean;
  apiOrigin?: string;
  routing?: string;
}

export const collectDocsModality: Modality = {
  name: "collect-docs",
  aliases: ["docs"],
  gated: false,
  summary: "Walk the app's screens and overlays and write its user docs (Markdown with screenshots)",
  async run(ctx: ModalityContext): Promise<void> {
    const opts = ctx.flags as unknown as CollectDocsFlags;
    const maxScreens = opts.maxPages === undefined ? DEFAULT_MAX_SCREENS : Number(opts.maxPages);
    if (!Number.isInteger(maxScreens) || maxScreens < 1) throw new Error(`--max-pages must be a whole number of 1 or more (got "${opts.maxPages}").`);
    const config = resolveConfig({ routing: opts.routing, channel: opts.channel });
    ctx.err(`▸ Collecting docs from ${opts.url}${opts.session ? ` (session: ${opts.session})` : ""}…\n`);
    const progress = makeCliProgress({ write: ctx.err, isTTY: Boolean(ctx.isTTY), now: Date.now });
    const result = await runCollectDocs({
      url: opts.url,
      config,
      sessionName: opts.session,
      sessionFile: opts.sessionFile,
      out: opts.out,
      maxScreens,
      fresh: opts.fresh,
      headed: opts.headed,
      apiOrigins: opts.apiOrigin,
      onProgress: progress.event,
    }).finally(() => progress.stop());

    const { sections, questions } = result.model;
    const screens = sections.filter((s) => s.kind === "Screen").length;
    ctx.out(`\n=== Docs: ${screens} screen(s), ${sections.length - screens} overlay(s), ${questions.length} question(s) → ${displayPath(result.docsFile)} ===\n`);
    for (const s of sections) ctx.out(`  ${s.kind}: ${s.title}\n`);
    ctx.out(`\nDescriptions: ${result.described} written by the model, ${result.cached} reused from the cache (unchanged screens).\n`);
    if (result.openApiFile) ctx.out(`OpenAPI draft from the traffic: ${displayPath(result.openApiFile)}\n`);
    if (questions.length > 0) ctx.out(`Open questions are at the end of ${displayPath(result.docsFile)} — answer them there.\n`);
    printCost(result.cost, ctx.out);
  },
};
