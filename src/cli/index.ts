#!/usr/bin/env node
/**
 * CLI `lex-bot`. Commands: observe · explore · design · automate · dataset-add · experiment.
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { BOT_NAME, BOT_VERSION } from "../index.js";
import { makeGateway } from "../browser/index.js";
import type { BackendKind, StorageState } from "../browser/index.js";
import { capture } from "../observe/index.js";
import { SessionStore } from "../session/index.js";
import { loadConfig } from "../config/index.js";
import { runExploration, runDesign, runAutomate } from "../agent/index.js";
import { promoteCase, locatorFor } from "../promote/index.js";
import type { PromoteDeps } from "../promote/index.js";
import { makeModel } from "../llm/index.js";
import { structuredInvoker } from "../llm/structured.js";
import { PromptRegistry, LOCAL_PROMPTS } from "../prompts/index.js";
import { runExperiment, type DatasetItem, type Variant } from "../eval/experiment.js";
import type { PageStudy } from "../observe/index.js";

const program = new Command();
program
  .name("lex-bot")
  .description(`${BOT_NAME} — autonomous UI test generator`)
  .version(BOT_VERSION);

program
  .command("observe")
  .description("Explore a page: ARIA snapshot + interactive elements + screenshot")
  .requiredOption("--url <url>", "page URL")
  .option("--backend <kind>", "lib | cli", "lib")
  .option("--session <name>", "name of the saved session (.auth/<name>.storageState.json)")
  .option("--out <file>", "where to save the screenshot", "observe-screenshot.png")
  .action(async (opts: { url: string; backend: string; session?: string; out: string }) => {
    const backend: BackendKind = opts.backend === "cli" ? "cli" : "lib";
    const config = loadConfig(process.env);
    let storageState: StorageState | undefined;
    if (opts.session) {
      storageState = await new SessionStore(resolve(".auth")).load(opts.session);
    }
    const gateway = makeGateway({ backend, storageState, channel: config.browser.channel });
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

program
  .command("explore")
  .description("Explore a page and generate methodology-based test cases (Sprint 2: no code)")
  .requiredOption("--url <url>", "page URL")
  .option("--backend <kind>", "lib | cli (overrides BROWSER_BACKEND)")
  .option("--session <name>", "name of the saved session (.auth/<name>.storageState.json)")
  .option("--session-file <path>", "direct path to a storageState file (any name)")
  .option("--headed", "visible browser (debug)")
  .option("--checklist <file>", "checklist file (md/text) — guides what to test")
  .option("--style <s>", "planning style: happy | negative | coverage | all")
  .action(
    async (opts: {
      url: string;
      backend?: string;
      session?: string;
      sessionFile?: string;
      headed?: boolean;
      checklist?: string;
      style?: string;
    }) => {
      const env: Record<string, string | undefined> = { ...process.env };
      if (opts.backend) env.BROWSER_BACKEND = opts.backend;
      const config = loadConfig(env);
      const checklistText = opts.checklist ? await readFile(opts.checklist, "utf8") : undefined;
      process.stderr.write(
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
        onProgress: (e) => process.stderr.write(`  ▸ ${e}\n`),
      });

    process.stdout.write(`\n=== Exploration of ${result.study.url} (run ${result.runId}) ===\n`);
    process.stdout.write(`Purpose: ${result.analysis.pageSemantics}\n`);
    process.stdout.write(`LLM profile: ${config.llmProfile} · test cases: ${result.testCases.length}\n\n`);
    for (const tc of result.testCases) {
      process.stdout.write(`[${tc.id}] (${tc.priority} · ${tc.technique}) ${tc.title}\n`);
      for (const step of tc.steps) process.stdout.write(`    - ${step}\n`);
      process.stdout.write(`    ⇒ ${tc.expected}\n`);
      if (tc.elementRefs.length) process.stdout.write(`    refs: ${tc.elementRefs.join(", ")}\n`);
      process.stdout.write("\n");
    }

    if (result.validation) {
      const v = result.validation;
      process.stdout.write(
        `=== Validation: ${Math.round(v.greenRatio * 100)}% green (flaky: ${v.flakyCount}) ===\n`,
      );
      for (const r of v.results) {
        const mark = r.status === "passed" ? "✓" : r.status === "flaky" ? "~" : "✗";
        process.stdout.write(`  ${mark} ${r.test}\n`);
      }
    }
    if (result.scores.length > 0) {
      process.stdout.write("\n=== Metrics ===\n");
      for (const s of result.scores) {
        process.stdout.write(
          `  ${s.name}: ${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""}\n`,
        );
      }
    }
    if (result.pilot) {
      process.stdout.write(
        `\n=== Pilot: ${result.pilot.verdict.toUpperCase()} ===\n  ${result.pilot.reason}\n  → ${result.pilot.guidance}\n`,
      );
    }
    process.stdout.write(`\nArtifacts: ${result.runDir}\n`);
  });

program
  .command("dataset-add")
  .description("Add a run (study.json) to an experiment dataset")
  .requiredOption("--from-run <dir>", "runs/<id> folder")
  .requiredOption("--to <file>", "dataset file (JSON)")
  .action(async (opts: { fromRun: string; to: string }) => {
    const study = JSON.parse(await readFile(join(opts.fromRun, "study.json"), "utf8")) as PageStudy;
    let pageSemantics = "";
    try {
      const rep = JSON.parse(await readFile(join(opts.fromRun, "report.json"), "utf8")) as {
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
    };
    const ds = JSON.parse(await readFile(opts.dataset, "utf8")) as { items: DatasetItem[] };

    const variants: Variant[] = [{ label: "production", prompts: new PromptRegistry() }];
    if (opts.candidate) {
      const eq = opts.candidate.indexOf("=");
      const name = opts.candidate.slice(0, eq);
      const text = await readFile(opts.candidate.slice(eq + 1), "utf8");
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
        designInvoke: structuredInvoker(makeModel(config.models.reasoning, keys)),
        judgeInvoke: structuredInvoker(makeModel(config.models.judge, keys)),
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
  .option("--checklist <file>", "checklist file — guides what to test")
  .option("--style <s>", "planning style: happy | negative | coverage | all")
  .option("--headed", "visible browser (debug)")
  .action(
    async (opts: {
      url: string;
      session?: string;
      sessionFile?: string;
      checklist?: string;
      style?: string;
      headed?: boolean;
    }) => {
      const config = loadConfig(process.env);
      const checklistText = opts.checklist ? await readFile(opts.checklist, "utf8") : undefined;
      process.stderr.write(`▸ Designing test cases for ${opts.url}${opts.session ? ` (session: ${opts.session})` : ""}…\n`);
      const result = await runDesign({
        url: opts.url,
        config,
        sessionName: opts.session,
        sessionFile: opts.sessionFile,
        checklistText,
        style: opts.style,
        headed: opts.headed,
        onProgress: (e) => process.stderr.write(`  ▸ ${e}\n`),
      });

      process.stdout.write(
        `\n=== ${result.testCases.length} test cases → ${result.runDir}\\testcases\\ ===\n`,
      );
      for (const tc of result.testCases) {
        const exec = tc.execution === "manual" ? "MTC/manual" : "ATC/auto";
        process.stdout.write(`[${exec} · ${tc.priority}/${tc.type}] ${tc.title}\n`);
      }
      for (const f of result.testCaseFiles) process.stdout.write(`  ${f}\n`);
      if (result.scores.length > 0) {
        process.stdout.write("\n=== Metrics ===\n");
        for (const s of result.scores) {
          process.stdout.write(`  ${s.name}: ${s.value.toFixed(2)}${s.comment ? ` — ${s.comment}` : ""}\n`);
        }
      }
    },
  );

program
  .command("automate")
  .description("Generate @playwright/test from ready cases (runs/<id>/testcases/*.md)")
  .requiredOption("--run <dir>", "design run folder (runs/<id>)")
  .option("--validate", "run the generated tests (a session is required)")
  .option("--session <name>", "session name for validation")
  .option("--session-file <path>", "path to storageState for validation")
  .action(
    async (opts: { run: string; validate?: boolean; session?: string; sessionFile?: string }) => {
      const config = loadConfig(process.env);
      process.stderr.write(`▸ Automating cases from ${opts.run}…\n`);
      const result = await runAutomate({
        runDir: opts.run,
        config,
        validate: opts.validate,
        sessionName: opts.session,
        sessionFile: opts.sessionFile,
        onProgress: (e) => process.stderr.write(`  ▸ ${e}\n`),
      });
      process.stdout.write(
        `\n=== ${result.specFiles.length} spec files → ${result.runDir}\\tests\\ ===\n`,
      );
      for (const f of result.specFiles) process.stdout.write(`  ${f}\n`);
      if (result.validation) {
        process.stdout.write(
          `\nValidation: ${Math.round(result.validation.greenRatio * 100)}% green out of ${result.validation.results.length} tests\n`,
        );
      }
    },
  );

program
  .command("promote")
  .description("Promote manual MTC case(s) to automatable ATC (.md only; run `automate` to generate code)")
  .requiredOption("--run <dir>", "run folder (runs/<id>)")
  .requiredOption("--cases <ids>", "comma-separated MTC ids, e.g. MTC-DEMO-001,MTC-DEMO-003")
  .option("--session <name>", "session for the live selector fallback")
  .option("--session-file <path>", "storageState path for the live selector fallback")
  .action(
    async (opts: { run: string; cases: string; session?: string; sessionFile?: string }) => {
      const config = loadConfig(process.env);
      const runDir = resolve(opts.run);
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

      process.stderr.write(`▸ Promoting ${String(ids.length)} case(s) from ${opts.run}…\n`);
      for (const id of ids) {
        const res = await promoteCase(runDir, id, { collectLive });
        process.stdout.write(`${res.oldId} → ${res.newId}${res.warning ? ` (⚠ ${res.warning})` : ""}\n`);
      }
      process.stdout.write(`\nDone. Run \`lex-bot automate --run ${opts.run}\` to generate code for the new ATC case(s).\n`);
    },
  );

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
