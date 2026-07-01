#!/usr/bin/env node
/**
 * CLI `cairn`. Commands: observe · explore · design · automate · dataset-add · experiment ·
 * promote · session · login, plus GATED modality stubs (ui|e2e / api / unit / docs — C1-01).
 * The umbrella router is thin: each modality command dispatches through the shared core
 * (`runModality`), so a future modality is a thin add, not a fork.
 * `lex-bot` stays as a hidden, deprecated alias (see ./lex-bot.ts) → same code path.
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { isMainEntry } from "./is-main.js";
import { BOT_NAME, BOT_VERSION } from "../index.js";
import { makeGateway } from "../browser/index.js";
import type { BackendKind, StorageState } from "../browser/index.js";
import { installBrowsers, doctorReport } from "../browser/install.js";
import { capture } from "../observe/index.js";
import { SessionStore, captureSession } from "../session/index.js";
import { loadConfig } from "../config/index.js";
import { runDesign, runAutomate } from "../agent/index.js";
import { renderRunSummary, displayPath } from "../agent/summary.js";
import { resolveRunDir, defaultRunsBaseDir, readInputFile } from "../fs/run-dir.js";
import { resolveStyleText } from "../design/style.js";
import { promoteCase, locatorFor } from "../promote/index.js";
import type { PromoteDeps } from "../promote/index.js";
import { makeModel, structuredMethodFor } from "../llm/index.js";
import { structuredInvoker } from "../llm/structured.js";
import { PromptRegistry, LOCAL_PROMPTS } from "../prompts/index.js";
import { runExperiment, type DatasetItem, type Variant } from "../eval/experiment.js";
import type { PageStudy } from "../observe/index.js";
// C1-01 — shared umbrella core: flag→config, the cost footer, and the modality registry/dispatch.
import { resolveConfig, printCost, runModality, MODALITIES, makeCliProgress } from "../core/index.js";
import { dirGlyph } from "../eval/legend.js";

/**
 * Shared capture action for `cairn session capture` and the flat `cairn login` alias.
 * Opens a headed browser, waits for login, and persists the session (L1-05). Never prints secrets.
 */
async function runCapture(opts: { url: string; name?: string; channel?: string; dir?: string }): Promise<void> {
  const config = loadConfig(process.env);
  process.stderr.write(`▸ Capturing a session at ${opts.url}…\n`);
  const res = await captureSession({
    url: opts.url,
    name: opts.name,
    channel: opts.channel ?? config.browser.channel,
    dir: opts.dir,
    onLog: (m) => process.stderr.write(`  ▸ ${m}\n`),
  });
  process.stdout.write(`\n✓ Session "${res.name}" saved → ${res.path}\n`);
  process.stdout.write(`  Next: cairn explore --url <app-url> --session ${res.name}\n`);
  process.stdout.write(`  Note: .auth/ is gitignored — never commit session files.\n`);
}

/**
 * Build the `cairn` commander program. Exported (C1-02) so tests can drive commands and snapshot
 * `--help` without running the process entry point. Each call returns a fresh, independent program.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("cairn")
    .description(`${BOT_NAME} — autonomous UI test generator`)
    .version(BOT_VERSION);

  program
    .command("observe")
    .description("Explore a page: ARIA snapshot + interactive elements + screenshot")
    .requiredOption("--url <url>", "page URL")
    .option("--backend <kind>", "lib | cli", "lib")
    .option("--channel <channel>", "system browser channel, e.g. chrome — drives your installed Chrome (no bundled-Chromium download)")
    .option("--session <name>", "name of the saved session (.auth/<name>.storageState.json)")
    .option("--out <file>", "where to save the screenshot", "observe-screenshot.png")
    .action(async (opts: { url: string; backend: string; channel?: string; session?: string; out: string }) => {
      const backend: BackendKind = opts.backend === "cli" ? "cli" : "lib";
      const config = loadConfig(process.env);
      let storageState: StorageState | undefined;
      if (opts.session) {
        storageState = await new SessionStore(resolve(".auth")).load(opts.session);
      }
      const gateway = makeGateway({ backend, storageState, channel: opts.channel ?? config.browser.channel });
      try {
        const study = await capture(gateway, opts.url);
        const interactive = study.elements.filter((e) => e.interactive);
        process.stdout.write(`URL: ${study.url} (backend: ${study.capturedBy})\n`);
        process.stdout.write(
          `Elements: ${study.elements.length}, interactive: ${interactive.length}\n\n`,
        );
        process.stdout.write(`${study.ariaYaml}\n\nInteractive:\n`);
        for (const e of interactive) {
          process.stdout.write(`  [${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ""}\n`);
        }
        await mkdir(dirname(opts.out), { recursive: true });
        await writeFile(opts.out, Buffer.from(study.screenshotB64, "base64"));
        process.stdout.write(`\nScreenshot → ${opts.out}\n`);
      } finally {
        await gateway.close();
      }
    });

  // explore = the first REAL modality. The command keeps its exact flags/description (parity,
  // C1-02); its action delegates to the shared core (runModality → exploreModality.run).
  program
    .command("explore")
    .description("Explore a page and generate methodology-based test cases (Sprint 2: no code)")
    .requiredOption("--url <url>", "page URL")
    .option("--backend <kind>", "lib | cli (overrides BROWSER_BACKEND)")
    .option("--channel <channel>", "system browser channel, e.g. chrome — drives your installed Chrome (no bundled-Chromium download; helps OAuth)")
    .option("--session <name>", "name of the saved session (.auth/<name>.storageState.json)")
    .option("--session-file <path>", "direct path to a storageState file (any name)")
    .option("--headed", "visible browser (debug)")
    .option("--checklist <file>", "checklist file (md/text) — guides what to test")
    .option("--goal <text>", "natural-language goal — bias observation + cases toward it (e.g. \"test the checkout flow\") instead of a blind crawl")
    .option("--style <s>", "planning style: happy | negative | coverage | all")
    .option("--fresh", "ignore prior runs for this URL — generate a full set, don't dedupe against past cases")
    .option("--routing <preset>", "role-routing preset: fast (Groq worker) | volume (OpenRouter worker) | volume-fast (Anthropic codegen, cheap judge on OpenRouter) (sets LLM_ROUTING)")
    .option("--critique", "self-critique pass after design: prune weak cases + top up technique gaps (1 extra worker-tier LLM call)")
    .option("--flow", "follow in-app navigation across pages and design multi-page journey cases (opt-in)")
    .option("--max-pages <n>", "max pages to crawl with --flow (page cap; default 3)")
    .option("--setup", "for journeys (--flow): plan + emit starting-state setup (fixture / API seed; manual fallback)")
    .option("--gaps", "suggest cases for the top untested surface (the coverage view is always emitted)")
    .option("--into-project [dir]", "write specs into an existing Playwright project's testDir (detect playwright.config.*; respects testDir/naming) instead of runs/<id>/tests")
    .option("--screencast", "record a .webm per scenario (with step chapters) during validation → runs/<id>/screencasts/ for the review gate")
    .action(async (opts: Record<string, unknown>) => {
      await runModality("explore", opts);
    });

  // api = the second REAL modality (C1-04 / #22), shipped one slice at a time. API-1 ingests an
  // OpenAPI 3.x spec into the internal endpoint model and prints a summary — no generation yet.
  program
    .command("api")
    .description("Generate API tests from an OpenAPI 3.x spec; with --base-url, run them and assert responses")
    .requiredOption("--spec <path|url>", "OpenAPI 3.x spec — JSON or YAML, a local file path or an http(s) URL")
    .option("--base-url <url>", "API-3: base URL to execute the generated cases against (assert status + schema)")
    .option(
      "--header <header>",
      "API-3: extra request header 'Name: Value' (repeatable); overrides knowledge-supplied headers",
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .option("--out <dir>", "API-3: where to write run evidence (default runs/api-<id>/)")
    .option("--knowledge-dir <dir>", "API-3: dir holding api-scope auth/headers knowledge (default knowledge/)")
    .option("--negative", "API-8: also generate/run one negative-schema (contract-violation) case per operation")
    .option("--scenarios", "API-9: also generate/run multi-endpoint scenario chains (e.g. create → read → delete)")
    .action(async (opts: Record<string, unknown>) => {
      await runModality("api", opts);
    });

  program
    .command("dataset-add")
    .description("Add a run (study.json) to an experiment dataset")
    .requiredOption("--from-run <dir>", "run folder: runs/<id> or a bare <id>")
    .requiredOption("--to <file>", "dataset file (JSON)")
    .action(async (opts: { fromRun: string; to: string }) => {
      const fromRun = await resolveRunDir(opts.fromRun, { runsBaseDir: defaultRunsBaseDir() });
      const study = JSON.parse(await readFile(join(fromRun, "study.json"), "utf8")) as PageStudy;
      let pageSemantics = "";
      try {
        const rep = JSON.parse(await readFile(join(fromRun, "report.json"), "utf8")) as {
          pageSemantics?: string;
        };
        pageSemantics = rep.pageSemantics ?? "";
      } catch {
        // report.json is optional
      }
      let ds: { items: DatasetItem[] } = { items: [] };
      try {
        ds = JSON.parse(await readFile(opts.to, "utf8")) as { items: DatasetItem[] };
      } catch {
        // new dataset
      }
      const id = `item-${ds.items.length + 1}`;
      ds.items.push({ id, study, pageSemantics });
      await mkdir(dirname(opts.to) || ".", { recursive: true });
      await writeFile(opts.to, JSON.stringify(ds, null, 2), "utf8");
      process.stdout.write(`Added ${id} → ${opts.to} (total items: ${ds.items.length})\n`);
    });

  program
    .command("experiment")
    .description("Compare prompt versions on a dataset (B2 self-improvement)")
    .requiredOption("--dataset <file>", "dataset file (JSON)")
    .option("--candidate <spec>", "promptName=file.md — candidate prompt vs production")
    .option("--target <metric>", "target verdict metric", "grounding")
    .action(async (opts: { dataset: string; candidate?: string; target: string }) => {
      const config = loadConfig(process.env);
      const keys = {
        anthropicApiKey: config.anthropicApiKey,
        openrouterApiKey: config.openrouterApiKey,
        groqApiKey: config.groqApiKey,
      };
      const ds = JSON.parse(await readInputFile(opts.dataset, "Dataset")) as { items: DatasetItem[] };

      const variants: Variant[] = [{ label: "production", prompts: new PromptRegistry() }];
      if (opts.candidate) {
        const eq = opts.candidate.indexOf("=");
        const name = opts.candidate.slice(0, eq);
        const text = await readInputFile(opts.candidate.slice(eq + 1), "Candidate prompt");
        variants.push({
          label: "candidate",
          prompts: new PromptRegistry({ local: { ...LOCAL_PROMPTS, [name]: text } }),
        });
      }

      process.stderr.write(`▸ Experiment: ${ds.items.length} items × ${variants.length} versions…\n`);
      const result = await runExperiment(
        ds.items,
        variants,
        {
          designInvoke: structuredInvoker(
            makeModel(config.models.reasoning, keys),
            structuredMethodFor(config.models.reasoning.provider),
          ),
          judgeInvoke: structuredInvoker(
            makeModel(config.models.judge, keys),
            structuredMethodFor(config.models.judge.provider),
          ),
        },
        { target: opts.target },
      );

      process.stdout.write(`\n=== Experiment (${ds.items.length} items) ===\n`);
      for (const v of result.perVariant) {
        process.stdout.write(`\n[${v.label}]\n`);
        for (const [name, val] of Object.entries(v.meanScores)) {
          process.stdout.write(`  ${name}: ${val.toFixed(3)}\n`);
        }
      }
      if (result.verdict) {
        const vd = result.verdict;
        const reg = vd.guardrailRegressions.length ? `; regressions: ${vd.guardrailRegressions.join(", ")}` : "";
        process.stdout.write(
          `\n=== Verdict: candidate ${vd.improved ? "BETTER ✓" : "NOT better ✗"} (${vd.target} Δ=${vd.delta.toFixed(3)})${reg} ===\n`,
        );
        process.stdout.write(
          vd.improved
            ? "  → the version can be promoted (Langfuse label=production) — runbook promote-prompt.\n"
            : "  → reject/iterate the prompt.\n",
        );
      }
    });

  program
    .command("design")
    .description("Explore a page and WRITE test cases in ATC format (.md, with selectors), WITHOUT code")
    .requiredOption("--url <url>", "page URL")
    .option("--session <name>", "name of the saved session")
    .option("--session-file <path>", "path to a storageState file")
    .option("--channel <channel>", "system browser channel, e.g. chrome — drives your installed Chrome (no bundled-Chromium download; helps OAuth)")
    .option("--checklist <file>", "checklist file — guides what to test")
    .option("--style <s>", "planning style: happy | negative | coverage | all")
    .option("--fresh", "ignore prior runs for this URL — generate a full set, don't dedupe against past cases")
    .option("--routing <preset>", "role-routing preset: fast (Groq worker) | volume (OpenRouter worker) | volume-fast (Anthropic codegen, cheap judge on OpenRouter) (sets LLM_ROUTING)")
    .option("--critique", "self-critique pass after design: prune weak cases + top up technique gaps (1 extra worker-tier LLM call)")
    .option("--flow", "follow in-app navigation across pages and design multi-page journey cases (opt-in)")
    .option("--max-pages <n>", "max pages to crawl with --flow (page cap; default 3)")
    .option("--setup", "for journeys (--flow): plan + emit starting-state setup (fixture / API seed; manual fallback)")
    .option("--gaps", "suggest cases for the top untested surface (the coverage view is always emitted)")
    .option("--headed", "visible browser (debug)")
    .action(
      async (opts: {
        url: string;
        session?: string;
        sessionFile?: string;
        channel?: string;
        checklist?: string;
        style?: string;
        headed?: boolean;
        routing?: string;
        fresh?: boolean;
        critique?: boolean;
        flow?: boolean;
        maxPages?: string;
        setup?: boolean;
        gaps?: boolean;
      }) => {
        const config = resolveConfig({ routing: opts.routing, channel: opts.channel });
        const checklistText = opts.checklist ? await readInputFile(opts.checklist, "Checklist") : undefined;
        // #80: --style resolves to a house-style pack file (prompts/styles/<v>.md or a path) → {{style}} slot,
        // else the built-in inline hint (happy/negative/coverage). Methodology is never touched.
        const styleText = await resolveStyleText(opts.style);
        process.stderr.write(`▸ Designing test cases for ${opts.url}${opts.session ? ` (session: ${opts.session})` : ""}…\n`);
        const progress = makeCliProgress({
          write: (s) => void process.stderr.write(s),
          isTTY: Boolean(process.stderr.isTTY),
          now: Date.now,
        });
        const result = await runDesign({
          url: opts.url,
          config,
          sessionName: opts.session,
          sessionFile: opts.sessionFile,
          checklistText,
          style: opts.style,
          styleText,
          headed: opts.headed,
          fresh: opts.fresh,
          critique: opts.critique,
          flow: opts.flow,
          maxPages: opts.flow ? Number(opts.maxPages) || 3 : undefined,
          setup: opts.setup,
          gaps: opts.gaps,
          onProgress: progress.event,
        }).finally(() => progress.stop());

        process.stdout.write(
          `\n=== ${result.testCases.length} test cases → ${displayPath(result.runDir)}/testcases/ ===\n`,
        );
        for (const tc of result.testCases) {
          const exec = tc.execution === "manual" ? "MTC/manual" : "ATC/auto";
          process.stdout.write(`[${exec} · ${tc.priority}/${tc.type}] ${tc.title}\n`);
        }
        for (const f of result.testCaseFiles) process.stdout.write(`  ${displayPath(f)}\n`);
        if (result.scores.length > 0) {
          process.stdout.write("\n=== Metrics ===  (↑ higher is better · ↓ lower is better)\n");
          for (const s of result.scores) {
            const g = dirGlyph(s.name);
            process.stdout.write(`  ${s.name}${g ? ` ${g}` : ""}: ${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""}\n`);
          }
        }
        printCost(result.cost);
      },
    );

  program
    .command("automate")
    .description("Generate @playwright/test from ready cases (runs/<id>/testcases/*.md)")
    .requiredOption("--run <dir>", "run folder: runs/<id>, a bare <id>, or an absolute path (Git Bash: quote or use /)")
    .option("--validate", "run the generated tests (a session is required)")
    .option("--session <name>", "session name for validation")
    .option("--session-file <path>", "path to storageState for validation")
    .option("--channel <channel>", "system browser channel, e.g. chrome — validate on your installed Chrome (no bundled-Chromium download)")
    .option("--routing <preset>", "role-routing preset: fast (Groq worker) | volume (OpenRouter worker) | volume-fast (Anthropic codegen, cheap judge on OpenRouter) (sets LLM_ROUTING)")
    .option("--into-project [dir]", "write specs into an existing Playwright project's testDir (detect playwright.config.*; respects testDir/naming) instead of runs/<id>/tests")
    .option("--screencast", "with --validate: record a .webm per scenario (with step chapters) → runs/<id>/screencasts/ for the review gate")
    .action(
      async (opts: { run: string; validate?: boolean; session?: string; sessionFile?: string; channel?: string; routing?: string; intoProject?: boolean | string; screencast?: boolean }) => {
        const config = resolveConfig({ routing: opts.routing, channel: opts.channel });
        process.stderr.write(`▸ Automating cases from ${displayPath(opts.run)}…\n`);
        const progress = makeCliProgress({
          write: (s) => void process.stderr.write(s),
          isTTY: Boolean(process.stderr.isTTY),
          now: Date.now,
        });
        const result = await runAutomate({
          runDir: opts.run,
          config,
          validate: opts.validate,
          sessionName: opts.session,
          sessionFile: opts.sessionFile,
          intoProject: opts.intoProject !== undefined && opts.intoProject !== false,
          projectDir: typeof opts.intoProject === "string" ? opts.intoProject : undefined,
          screencast: opts.screencast,
          onProgress: progress.event,
        }).finally(() => progress.stop());
        const dest = result.projectTestDir ? displayPath(result.projectTestDir) : `${displayPath(result.runDir)}/tests/`;
        process.stdout.write(
          `\n=== ${result.specFiles.length} spec files → ${dest} ===\n`,
        );
        for (const f of result.specFiles) process.stdout.write(`  ${displayPath(f)}\n`);
        if (result.validation) {
          process.stdout.write(
            `\nValidation: ${Math.round(result.validation.greenRatio * 100)}% green out of ${result.validation.results.length} tests\n`,
          );
        }
        printCost(result.cost);
        // L1-04 (Box 4): same consolidated footer as `explore` — pass/fail · cost · budget · path.
        process.stdout.write("\n");
        for (const line of renderRunSummary({
          runDir: result.runDir,
          validation: result.validation,
          cost: result.cost,
          budget: result.budget,
          stoppedEarly: result.stoppedEarly,
        })) {
          process.stdout.write(`${line}\n`);
        }
      },
    );

  // Browser setup (0.3.3): install Chromium via CAIRN'S OWN Playwright (matches the version cairn
  // launches), and diagnose the setup. These replace the generic `npx playwright install` guidance.
  program
    .command("install-browsers")
    .description("Download the Chromium build Cairn drives — uses Cairn's OWN Playwright, so the revision always matches")
    .action(async () => {
      const res = await installBrowsers({ onLog: (s) => process.stderr.write(s) });
      if (res.ok) {
        process.stdout.write(`\n✓ Chromium installed for Cairn's Playwright ${res.playwrightVersion}.\n`);
      } else {
        process.stderr.write(
          "\n✗ Browser install failed (see output above). You can also drive system Chrome with --channel chrome.\n",
        );
        process.exitCode = 1;
      }
    });

  program
    .command("doctor")
    .description("Diagnose the browser setup: Cairn's Playwright version, the Chromium it expects, and how to fix a missing build")
    .action(() => {
      for (const line of doctorReport()) process.stdout.write(`${line}\n`);
    });

  program
    .command("promote")
    .description("Promote manual MTC case(s) to automatable ATC (.md only; run `automate` to generate code)")
    .requiredOption("--run <dir>", "run folder: runs/<id>, a bare <id>, or an absolute path (Git Bash: quote or use /)")
    .requiredOption("--cases <ids>", "comma-separated MTC ids, e.g. MTC-DEMO-001,MTC-DEMO-003")
    .option("--session <name>", "session for the live selector fallback")
    .option("--session-file <path>", "storageState path for the live selector fallback")
    .action(
      async (opts: { run: string; cases: string; session?: string; sessionFile?: string }) => {
        const config = loadConfig(process.env);
        const runDir = await resolveRunDir(opts.run, { runsBaseDir: defaultRunsBaseDir() });
        const ids = opts.cases.split(",").map((s) => s.trim()).filter(Boolean);

        // Live fallback only when a session is provided (best-effort — see note).
        let collectLive: PromoteDeps["collectLive"];
        let storageState: StorageState | undefined;
        if (opts.sessionFile) storageState = await new SessionStore(resolve(".auth")).loadFile(resolve(opts.sessionFile));
        else if (opts.session) storageState = await new SessionStore(resolve(".auth")).load(opts.session);
        if (storageState) {
          collectLive = async (url: string, refs: string[]): Promise<Map<string, string>> => {
            const gateway = makeGateway({ backend: config.browser.backend, storageState, channel: config.browser.channel });
            try {
              await gateway.observe({ url });
              const verified = await gateway.verify(refs.map((ref) => ({ ref, role: "", name: undefined, interactive: true, rank: 0 })));
              const out = new Map<string, string>();
              for (const v of verified) if (v.verified) out.set(v.ref, locatorFor(v));
              return out;
            } finally {
              await gateway.close();
            }
          };
        }

        process.stderr.write(`▸ Promoting ${String(ids.length)} case(s) from ${displayPath(opts.run)}…\n`);
        for (const id of ids) {
          const res = await promoteCase(runDir, id, { collectLive });
          process.stdout.write(`${res.oldId} → ${res.newId}${res.warning ? ` (⚠ ${res.warning})` : ""}\n`);
        }
        process.stdout.write(`\nDone. Run \`cairn automate --run ${displayPath(runDir)}\` to generate code for the new ATC case(s).\n`);
      },
    );

  // `cairn session <capture|ls|rm>` — first-class management of saved login sessions (L1-05).
  const session = program.command("session").description("Manage saved login sessions (.auth/)");

  session
    .command("capture")
    .description("Capture a login session interactively (opens a headed browser; press Enter when logged in)")
    .requiredOption("--url <loginUrl>", "login page URL to open")
    .option("--name <name>", "session name (default: derived from the URL host)")
    .option("--channel <channel>", "browser channel, e.g. chrome (helps with OAuth; default from config)")
    .option("--dir <dir>", "sessions directory", ".auth")
    .action(runCapture);

  session
    .command("ls")
    .description("List saved sessions")
    .option("--dir <dir>", "sessions directory", ".auth")
    .action(async (opts: { dir: string }) => {
      const names = await new SessionStore(resolve(opts.dir)).list();
      if (names.length === 0) {
        process.stdout.write(
          "No saved sessions. Capture one: cairn session capture --url <loginUrl> --name <name>\n",
        );
        return;
      }
      process.stdout.write(`Saved sessions (${opts.dir}):\n`);
      for (const n of names) process.stdout.write(`  ${n}\n`);
    });

  session
    .command("rm <name>")
    .description("Remove a saved session")
    .option("--dir <dir>", "sessions directory", ".auth")
    .action(async (name: string, opts: { dir: string }) => {
      const removed = await new SessionStore(resolve(opts.dir)).remove(name);
      process.stdout.write(removed ? `✓ Removed session "${name}".\n` : `No session "${name}" to remove.\n`);
    });

  // Flat alias: `cairn login` == `cairn session capture` (issue #27 — acceptable shorthand).
  program
    .command("login")
    .description("Alias for `cairn session capture` — capture a login session interactively")
    .requiredOption("--url <loginUrl>", "login page URL to open")
    .option("--name <name>", "session name (default: derived from the URL host)")
    .option("--channel <channel>", "browser channel, e.g. chrome (helps with OAuth; default from config)")
    .option("--dir <dir>", "sessions directory", ".auth")
    .action(runCapture);

  // C1-01: GATED modality stubs (ui|e2e, api, unit, docs). Discoverable placeholders with ZERO
  // generation logic — each dispatches through runModality, which prints the coming-soon notice and
  // exits 0. #21–24 stay gated behind a named-user pull (L-G2 / #25): build by demand, one at a time.
  for (const m of MODALITIES.filter((x) => x.gated)) {
    const c = program
      .command(m.name)
      .description(`${m.summary} — coming soon (gated; see L-G2)`)
      .action(async () => {
        await runModality(m.name, {});
      });
    if (m.aliases?.length) c.aliases(m.aliases);
  }

  program
    .command("mcp")
    .description("run an MCP server (stdio) exposing explore/design as tools for Claude Code / Cursor")
    .action(async () => {
      // Lazy: @modelcontextprotocol/sdk is an OPTIONAL dependency — keep it off every other code path.
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer();
    });

  program
    .command("ci")
    .description("CI / PR bot (#50): run cairn on a PR from GitHub Action inputs/env, post a summary comment, optionally open a follow-up PR")
    .action(async () => {
      // Thin wrapper: all config comes from the action's inputs (INPUT_* env) + the GitHub event.
      const { startCi } = await import("../ci/index.js");
      await startCi();
    });

  return program;
}

/**
 * Run the CLI. Shared by the primary `cairn` entry (this file) and the deprecated
 * `lex-bot` alias shim (./lex-bot.ts), so both go through the exact same code path.
 */
export async function runCli(): Promise<void> {
  const program = buildProgram();
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    // No command in an interactive terminal → launch the TUI (lazy: keeps React/Ink
    // out of every other code path, incl. library embedders).
    const { mountTui } = await import("../tui/index.js");
    await mountTui();
  } else if (cliArgs.length === 0) {
    // No command but non-TTY (pipe/CI) → print usage instead of crashing Ink raw-mode.
    program.outputHelp();
  } else {
    await program.parseAsync(process.argv).catch((e: unknown) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exitCode = 1;
    });
  }
}

// Auto-run only when invoked directly as the `cairn` bin — NOT when imported by the
// `lex-bot` alias shim (which calls runCli() itself after printing the deprecation notice).
// isMainEntry resolves symlinks, so this still fires under `npm link` and `npm i -g` on
// Linux/macOS (where the global bin is a symlink) — a naive URL compare would silently no-op.
if (isMainEntry(process.argv[1], import.meta.url)) {
  await runCli();
}
