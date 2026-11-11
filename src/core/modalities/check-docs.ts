/**
 * #231 — the `check-docs` modality: do the docs match the UI? The work is `runCheckDocs` (`agent/check-docs.ts`); this
 * is the CLI glue. It needs no LLM key: the walk makes no LLM call. Exit 0 when the docs match, 2 on a mismatch (for
 * CI), 1 when the docs could not be read or the app could not be walked.
 */
import { runCheckDocs } from "../../agent/check-docs.js";
import { DEFAULT_MAX_SCREENS } from "../../agent/collect-docs.js";
import { displayPath } from "../../agent/summary.js";
import { createEnvReader } from "../../config/env.js";
import { BrowserBackendSchema } from "../../config/schema.js";
import { DOCS_MISMATCH_EXIT_CODE, MATCH_LINE } from "../../documentarian/check.js";
import { makeCliProgress } from "../progress.js";
import type { Modality, ModalityContext } from "../modality.js";

interface CheckDocsFlags {
  docs: string;
  url: string;
  spec?: string;
  session?: string;
  sessionFile?: string;
  channel?: string;
  headed?: boolean;
  maxPages?: string;
  out?: string;
  apiOrigin?: string;
}

/** The browser settings as `loadConfig` reads them, without its LLM-key checks: this command calls no model. */
function browserFromEnv(channel?: string): { backend: "lib" | "cli"; channel?: string } {
  const read = createEnvReader(process.env);
  const raw = read("BROWSER_BACKEND");
  const backend = BrowserBackendSchema.safeParse(raw ?? "lib");
  if (!backend.success) throw new Error(`Invalid BROWSER_BACKEND='${raw}'. Allowed: lib | cli.`);
  const ch = channel ?? read("BROWSER_CHANNEL");
  return { backend: backend.data, ...(ch ? { channel: ch } : {}) };
}

export const checkDocsModality: Modality = {
  name: "check-docs",
  gated: false,
  summary: "Walk the app and compare it with its docs (the collect-docs format): screens, overlays, fields, controls",
  async run(ctx: ModalityContext): Promise<void> {
    const opts = ctx.flags as unknown as CheckDocsFlags;
    const maxScreens = opts.maxPages === undefined ? DEFAULT_MAX_SCREENS : Number(opts.maxPages);
    if (!Number.isInteger(maxScreens) || maxScreens < 1) throw new Error(`--max-pages must be a whole number of 1 or more (got "${opts.maxPages}").`);
    ctx.err(`▸ Checking ${opts.docs} against ${opts.url}${opts.session ? ` (session: ${opts.session})` : ""}…\n`);
    const progress = makeCliProgress({ write: ctx.err, isTTY: Boolean(ctx.isTTY), now: Date.now });
    const result = await runCheckDocs({
      docs: opts.docs,
      url: opts.url,
      browser: browserFromEnv(opts.channel),
      spec: opts.spec,
      sessionName: opts.session,
      sessionFile: opts.sessionFile,
      headed: opts.headed,
      maxScreens,
      out: opts.out,
      apiOrigins: opts.apiOrigin,
      onProgress: progress.event,
    }).finally(() => progress.stop());

    const { mismatches: ms, api } = result.report;
    if (result.mismatches === 0) ctx.out(`\n✓ ${MATCH_LINE}\n`);
    else {
      ctx.out(`\n✗ ${result.mismatches} mismatch(es) between the docs and the UI:\n`);
      for (const m of ms) {
        const label = m.kind === "missing-in-ui" ? "in the docs, not in the UI" : m.kind === "missing-in-docs" ? "in the UI, not in the docs" : "name differs";
        ctx.out(`  ${m.section}: ${m.what}${m.kind === "differs" ? ` ("${m.docs}" → "${m.ui}")` : ""} — ${label}\n`);
      }
      for (const o of api?.notInSpec ?? []) ctx.out(`  API ${o} — in the traffic, not in the spec\n`);
    }
    ctx.out(`Report: ${displayPath(result.reportFile)}\n`);
    if (result.mismatches > 0) process.exitCode = DOCS_MISMATCH_EXIT_CODE;
  },
};
