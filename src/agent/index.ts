import { randomUUID } from "node:crypto";
import { resolve, dirname, basename, join } from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { makeGateway } from "../browser/index.js";
import { ensureBrowsersInstalled } from "../browser/preflight.js";
import { RoleRouter, type CostReport } from "../llm/index.js";
import { CallBudget } from "../llm/structured.js";
import { PromptRegistry } from "../prompts/index.js";
import { initTelemetry } from "../telemetry/index.js";
import { ArtifactStore, rmrf, type RunWriter } from "../artifacts/index.js";
import { resolveProjectTarget, ejectSuiteToProject } from "../project/index.js";
import { renderReportMd } from "../artifacts/report.js";
import { parseTestCaseMd } from "../artifacts/testcase-md.js";
import { automateCases } from "../codegen/index.js";
import { lintSuite, lintHint } from "../codegen/lint.js";
import { deterministicScores, type Score } from "../eval/scorers.js";
import { computeCoverage } from "../eval/coverage.js";
import { designGapCases } from "../eval/gap-cases.js";
import { judgeTestCases, judgeChecklistCoverage } from "../eval/judge.js";
import { pilotReview, type PilotVerdict } from "../eval/pilot.js";
import { collectPriorRuns, unionPassedTitles, experienceForUrl } from "../eval/collect.js";
import { ingestChecklist, formatChecklist, formatGoal, coverageScore, styleDirective } from "../checklist/index.js";
import { loadKnowledge } from "../knowledge/index.js";
import type { InteractionMap } from "../documentarian/index.js";
import { validateSuite, type ValidationReport } from "../validate/index.js";
import { SessionStore } from "../session/index.js";
import { resolveRunDir, defaultRunsBaseDir } from "../fs/run-dir.js";
import { runExploreGraph } from "./graph.js";
import { flowReportPayload, flowSnapshotPath } from "../flow/crawl.js";
import { finalizeFailure } from "./finalize.js";
import { runRepairLoop } from "./repair-loop.js";
import { buildTestCaseDocs } from "./testcase-docs.js";
import { displayPath, type BudgetReport } from "./summary.js";
import type { AppConfig } from "../config/index.js";
import type { StorageState } from "../browser/index.js";
import type { PageStudy } from "../observe/index.js";
import type { PageAnalysis } from "../analyze/index.js";
import type { TestCase } from "../design/index.js";
import type { GeneratedSuite } from "../codegen/index.js";

export { runExploreGraph } from "./graph.js";
export type { ExploreDeps, ExploreOutcome } from "./graph.js";

export interface ExploreInput {
  url: string;
  config: AppConfig;
  checklistText?: string;
  /** #63 (MEM-01): natural-language goal — biases observation + planning toward it instead of a blind crawl. */
  goal?: string;
  /** Base directory for runs/ (default ./runs in the project — needed to resolve @playwright/test). */
  runsBaseDir?: string;
  /** Name of the saved session (cookies+localStorage) → .auth/<name>.storageState.json. */
  sessionName?: string;
  /** Direct path to a storageState file (names vary across projects) — takes priority over sessionName. */
  sessionFile?: string;
  /** Directory of saved sessions (default ./.auth). */
  sessionsDir?: string;
  /** Directory of domain knowledge (.md, URL-matched; default ./knowledge). */
  knowledgeDir?: string;
  /** #93: cross-run cache dir for the page-understanding artifact (default ./.cairn-cache/understanding). */
  understandingCacheDir?: string;
  /** Planning style: happy | negative | coverage | all (default all). */
  style?: string;
  /** #80: pre-resolved text for the prompt's {{style}} slot (a house-style pack). Wins over `style`. */
  styleText?: string;
  /** Test-case language (override; otherwise cfg.testCaseLanguage / env QA_TESTCASE_LANG / "English"). */
  language?: string;
  /** Visible browser (debug). */
  headed?: boolean;
  /** Live per-node progress (CLI prints to stderr). */
  onProgress?: (event: string) => void;
  /** Ignore prior-run experience for this URL (collectPriorRuns is skipped). */
  fresh?: boolean;
  /** #82: run the design-time self-critique pass (prune + technique top-up) on the worker tier. Default off. */
  critique?: boolean;
  /** #59: follow in-app navigation and design multi-page journey cases. Default off (single page). */
  flow?: boolean;
  /** #59: max pages to crawl when `flow` is on (page cap — cost guardrail). */
  maxPages?: number;
  /** #60: plan + emit starting-state setup (fixtures / API seed) for journeys. Default off. */
  setup?: boolean;
  /** #61: also suggest cases for the top untested surface (the coverage VIEW is always emitted). Default off. */
  gaps?: boolean;
  /** #51: write the final specs into an existing Playwright project's testDir (conventions-respecting) instead of runs/<id>/tests. */
  intoProject?: boolean;
  /** #51: explicit project dir for --into-project; when omitted, detection searches from cwd upward. */
  projectDir?: string;
  /** #94 (BORROW-05): record a `.webm` per scenario during validation (review-gate affordance). Default off. */
  screencast?: boolean;
}

export interface ExploreResult {
  runId: string;
  runDir: string;
  study: PageStudy;
  analysis: PageAnalysis;
  testCases: TestCase[];
  suite?: GeneratedSuite;
  validation?: ValidationReport;
  scores: Score[];
  pilot?: PilotVerdict;
  /** Per-role cost + tokens for the run (L1-01, ADR-0011). */
  cost: CostReport;
  /** Per-run LLM-call budget usage (L1-04, Box 3) — surfaced so a run can't silently burn out. */
  budget: BudgetReport;
  /** The repair loop bailed early because it stopped making progress (L1-04, Box 2). */
  stoppedEarly: boolean;
  /** ATC/MTC case docs written to testcases/ (#39 — explore now emits them like design). */
  testCaseFiles: string[];
  /** #51: when --into-project ejected specs into a host project, the absolute paths written there. */
  projectSpecFiles?: string[];
  /** #51: the host project's testDir the specs were ejected into (undefined in greenfield mode). */
  projectTestDir?: string;
}

/**
 * INT-03 (#51): if `--into-project` is set, eject the final best suite into a detected Playwright
 * project's testDir (conventions-respecting, collision-safe) and remove the run-private `tests/`
 * sandbox so the trail keeps NO duplicate of the deliverable. Validation/repair already ran against
 * that sandbox (same Playwright, identical result) — this only relocates the validated specs to where
 * the project's own runner discovers them. Returns {} (greenfield fallthrough) when not requested or
 * when no `playwright.config.*` is found; the caller then restores the suite to runs/<id>/tests.
 */
async function ejectToProjectIfRequested(opts: {
  intoProject?: boolean;
  projectDir?: string;
  suite?: GeneratedSuite;
  runWriter: RunWriter;
  onProgress: (event: string) => void;
}): Promise<{ projectSpecFiles?: string[]; projectTestDir?: string }> {
  if (!opts.intoProject || !opts.suite) return {};
  const target = await resolveProjectTarget({ dir: opts.projectDir });
  if (!target) {
    opts.onProgress(
      `into-project — no playwright.config.* found (searched from ${displayPath(process.cwd())} upward) — wrote to runs/<id>/tests instead.`,
    );
    return {};
  }
  const res = await ejectSuiteToProject(opts.suite.files, target);
  // Single deliverable: drop the run-private sandbox (+ its generated config) so the trail holds no
  // spec duplicate — study/report/testcases stay in runs/<id>/ (best-effort; never sinks the run).
  try {
    await rmrf(join(opts.runWriter.dir, "tests"));
    await rm(join(opts.runWriter.dir, "playwright.config.cjs"), { force: true });
  } catch {
    // best-effort cleanup
  }
  const renameNote = res.renamed.length ? ` · ${res.renamed.length} renamed (name collisions avoided)` : "";
  opts.onProgress(
    `into-project — wrote ${res.written.length} spec(s) → ${displayPath(res.testDir)}` +
      `${target.configPath ? ` (config: ${displayPath(target.configPath)})` : ""}${renameNote}`,
  );
  return { projectSpecFiles: res.written, projectTestDir: res.testDir };
}

/**
 * End-to-end exploration → methodological cases → runnable @playwright/test → validation/repair (MVP, Sprint 3).
 * Artifacts land in runsBaseDir/<runId>/; everything is traced in Langfuse.
 */
export async function runExploration(input: ExploreInput): Promise<ExploreResult> {
  const cfg = input.config;
  // Onboarding guardrail: explore observes + validates → it needs a browser. Fail fast with a
  // copy-paste fix BEFORE spending any LLM calls, instead of dying deep in the run (see preflight.ts).
  // FIX B (0.3.3): pass the channel — skipped when a system browser (chrome/msedge) is configured,
  // since that path needs no bundled Chromium (the bug: this fired even with BROWSER_CHANNEL=chrome).
  ensureBrowsersInstalled({ channel: cfg.browser.channel });
  const keys = { anthropicApiKey: cfg.anthropicApiKey, openrouterApiKey: cfg.openrouterApiKey, groqApiKey: cfg.groqApiKey };
  const budget = new CallBudget(80); // cost-guardrail: safeguard (normally ~6-10 calls/run)

  // Progress → live (CLI) + buffered into run.log, flushed incrementally so a mid-run kill
  // still leaves the log on disk (#38). `persistLog` is wired once the run dir exists.
  const logLines: string[] = [];
  let persistLog: () => void = () => undefined; // no-op until the run dir exists
  const onProgress = (event: string): void => {
    logLines.push(`${new Date().toISOString()}  ${event}`);
    input.onProgress?.(event);
    persistLog();
  };

  // L1-04 (Box 3): warn ONCE when the run nears the call budget, so it can't silently burn out.
  let warnedBudget = false;
  const onCharge = (used: number, max: number): void => {
    if (!warnedBudget && max > 0 && used / max >= 0.8) {
      warnedBudget = true;
      onProgress(`⚠ approaching the LLM-call budget (${used}/${max} calls — cost guardrail)`);
    }
  };
  const telemetry = await initTelemetry(cfg);
  const router = new RoleRouter(
    cfg,
    keys,
    budget,
    undefined,
    undefined,
    onCharge,
    telemetry.callbackHandler ? [telemetry.callbackHandler] : undefined, // Task 2: thread handler into each LLM call
  ); // L1-01: routing + cost ledger

  // Auth: load storageState into the gateway (observe) and pass the path to the runner (validate).
  let storageState: StorageState | undefined;
  let sessionPath: string | undefined;
  const sessionStore = new SessionStore(resolve(input.sessionsDir ?? ".auth"));
  if (input.sessionFile) {
    sessionPath = resolve(input.sessionFile);
    storageState = await sessionStore.loadFile(sessionPath);
  } else if (input.sessionName) {
    sessionPath = sessionStore.pathFor(input.sessionName);
    // load() (not loadFile): a missing named session yields an actionable message, not a raw ENOENT (L1-05).
    storageState = await sessionStore.load(input.sessionName);
  }

  const gateway = makeGateway({
    backend: cfg.browser.backend,
    storageState,
    channel: cfg.browser.channel,
    headless: !input.headed,
  });
  const prompts = new PromptRegistry();
  const artifacts = new ArtifactStore(resolve(input.runsBaseDir ?? defaultRunsBaseDir()));
  const runId = randomUUID();
  const runWriter = await artifacts.openRun(runId);
  // #38: now that the run dir exists, flush run.log on every progress event (best-effort).
  persistLog = () => void runWriter.writeLog(logLines.join("\n")).catch(() => undefined);

  // Checklist (Sprint 4): a human narrows down WHAT to test → steers the design + measures coverage.
  const checklistItems = input.checklistText ? ingestChecklist(input.checklistText) : [];
  const checklistFormatted = formatChecklist(checklistItems);
  const knowledgeText = await loadKnowledge(resolve(input.knowledgeDir ?? "knowledge"), { url: input.url });
  // #93: cross-run page-understanding cache (keyed by url + page fingerprint) — a re-run on the same
  // page reuses it and skips the ground LLM call. Persist the artifact into the run dir too (durability).
  const understandingCacheDir = resolve(input.understandingCacheDir ?? ".cairn-cache/understanding");
  const onUnderstanding = (map: InteractionMap): void =>
    void runWriter.writeUnderstanding(map).catch(() => undefined);
  // `--fresh` skips this disk read entirely → no "previously STABLE cases" dedup block, so the run
  // generates a full set (clean A/B comparison) instead of only the delta vs. past runs of this URL.
  const experienceText = await experienceForUrl({
    runsBaseDir: resolve(input.runsBaseDir ?? defaultRunsBaseDir()),
    url: input.url,
    currentRunId: runId,
    fresh: input.fresh,
  });
  const styleText = input.styleText ?? styleDirective(input.style ?? "all");
  const languageText = input.language ?? cfg.testCaseLanguage;

  // L1-01: resolve per-role tiers (override ?? profile tier), then build metered invokers.
  const visionTier = cfg.models.vision ?? cfg.models.reasoning;
  const analyzeTier = router.tierFor("worker", visionTier);
  const designTier = router.tierFor("reasoner", cfg.models.reasoning);
  const codegenTier = router.tierFor("worker", cfg.models.bulk);
  const deps = {
    gateway,
    prompts,
    analyzeInvoke: router.invoke("worker", analyzeTier),
    designInvoke: router.invoke("reasoner", designTier),
    codegenInvoke: router.invoke("worker", codegenTier),
    // #82: self-critique runs on the worker tier (CAIRN_ROLE_WORKER) to bound cost; built only when opted in.
    critiqueInvoke: input.critique ? router.invoke("worker", codegenTier) : undefined,
    critique: input.critique,
    flow: input.flow,
    maxPages: input.maxPages,
    setup: input.setup,
    // #60: setup planning runs on the worker tier (CAIRN_ROLE_WORKER); built only when opted in.
    setupInvoke: input.setup ? router.invoke("worker", router.tierFor("worker", cfg.models.bulk)) : undefined,
    useVision: analyzeTier.supportsVision,
    goalText: formatGoal(input.goal),
    understandingCacheDir,
    fresh: input.fresh,
    onUnderstanding,
    checklistText: checklistFormatted,
    knowledgeText,
    experienceText,
    styleText,
    languageText,
    runWriter,
    validate: (runDir: string) => validateSuite(runDir, { storageStatePath: sessionPath, channel: cfg.browser.channel, workers: cfg.playwrightWorkers, screencast: input.screencast }),
    maxRepair: cfg.maxRepair,
    onProgress,
    // #38: persist study + snapshots the moment observe succeeds, so a mid-run kill still leaves
    // the page study/screenshot/ARIA on disk (best-effort — never break the run).
    onStudy: async (study: PageStudy) => {
      try {
        await runWriter.writeStudy(study);
        if (study.screenshotB64) await runWriter.writeScreenshot(study.screenshotB64);
        await runWriter.writeAria(study.ariaYaml);
      } catch {
        // durability is best-effort
      }
    },
    // Durability: persist the ATC/MTC case docs the moment they are designed, so a kill during the long
    // codegen/validate phase still leaves the cases on disk (best-effort). suiteFromUrl(studyUrl)
    // matches the final write below → identical files, no duplicates.
    onTestCases: async (testCases: TestCase[], verified: import("../browser/index.js").VerifiedElement[], studyUrl: string) => {
      try {
        const { docs } = buildTestCaseDocs(testCases, verified, suiteFromUrl(studyUrl), checklistItems.length > 0);
        await runWriter.writeTestCases(docs);
      } catch {
        // durability is best-effort
      }
    },
    // L1-05: a session was supplied → fail fast if the first page is a login screen (expired session).
    expectAuthenticated: Boolean(input.sessionName || input.sessionFile),
    sessionName: input.sessionName,
  };

  try {
    // Task 2: wrap in a root trace so nested LangChain CallbackHandler generations attach to ONE trace.
    // Fix 2: the entire post-graph evaluation (scores + judges + pilot + score-attach) runs INSIDE
    // the callback so judge/pilot LLM calls fire the handler while the root span is still active.
    const result = await telemetry.runInTrace(
      "exploration",
      { runId, backend: cfg.browser.backend, profile: cfg.llmProfile },
      async () => {
        const out = await runExploreGraph(deps, { url: input.url, runId });

        // (Expired-session detection now fails fast inside the graph's identifyElements node — L1-05.)

        // keep-best: final = the BEST suite/validation across all attempts (repair could not make it worse).
        const suite = out.bestSuite ?? out.suite;
        const validation = out.bestValidation ?? out.validation;
        // #51: eject into an existing Playwright project when requested; else restore best to runs/<id>/tests.
        const ejected = await ejectToProjectIfRequested({
          intoProject: input.intoProject,
          projectDir: input.projectDir,
          suite,
          runWriter,
          onProgress,
        });
        if (!ejected.projectTestDir && out.bestSuite) await runWriter.writeSuite(out.bestSuite); // restore the best code on disk

        // Phase 4: study prior runs of this URL + collect the best (collect-best).
        const runsBase = resolve(input.runsBaseDir ?? defaultRunsBaseDir());
        const priorRuns = (await collectPriorRuns(runsBase, out.study.url)).filter((r) => r.runId !== runId);
        const currentPassed = (validation?.results ?? [])
          .filter((r) => r.status === "passed")
          .map((r) => r.test);
        const allTimePassing = unionPassedTitles([
          ...priorRuns,
          { runId, url: out.study.url, greenRatio: validation?.greenRatio ?? 0, passedTests: currentPassed },
        ]);
        const bestPriorGreen = priorRuns[0]?.greenRatio;
        onProgress(
          `collect — prior runs for URL: ${priorRuns.length}` +
            (bestPriorGreen !== undefined ? `; best so far: ${Math.round(bestPriorGreen * 100)}%` : "") +
            `; stable cases total (all-time): ${allTimePassing.length}`,
        );

        // B1: run metrics — deterministic scorers + LLM-judge (SDK-side).
        onProgress("score — scoring (scorers + LLM-judge)…");
        const scores: Score[] = deterministicScores({
          study: out.study,
          verified: out.verified,
          testCases: out.testCases,
          suite,
          validation,
        });
        try {
          scores.push(
            ...(await judgeTestCases(
              out.testCases,
              out.analysis.pageSemantics,
              router.invoke("judge", cfg.models.judge),
              prompts,
            )),
          );
        } catch {
          // the judge is not critical for the run
        }
        if (checklistItems.length > 0) {
          try {
            const cov = await judgeChecklistCoverage(
              checklistItems,
              out.testCases,
              router.invoke("judge", cfg.models.judge),
              prompts,
            );
            scores.push({ name: "checklist_coverage", value: cov.value, comment: cov.comment });
          } catch {
            // fallback: token-based coverage (offline / judge unavailable)
            scores.push({ name: "checklist_coverage", value: coverageScore(checklistItems, out.testCases) });
          }
        }
        onProgress(`score — ${scores.length} metrics`);

        // Best-effort: write scores to Langfuse against the trace (requires a self-hosted instance).
        // The trace is still active here (inside runInTrace) so last_trace_id is set.
        const traceId = telemetry.callbackHandler?.last_trace_id;
        if (telemetry.enabled && telemetry.client && traceId) {
          try {
            for (const sc of scores) {
              telemetry.client.score.create({
                traceId,
                name: sc.name,
                value: sc.value,
                comment: sc.comment,
                dataType: "NUMERIC",
              });
            }
          } catch {
            // best-effort
          }
        }

        // Pilot supervisor: a holistic verdict for the run (idea from explorbot).
        let pilot: PilotVerdict | undefined;
        try {
          // #91: the session log the provenance check verifies a "pass" against — what the run actually
          // touched (case titles/steps + observed element names). A "pass" naming an absent entity is rejected.
          const sessionLog = [
            ...out.testCases.flatMap((tc) => [tc.title, ...tc.steps]),
            ...out.verified.map((v) => v.name ?? "").filter(Boolean),
          ];
          pilot = await pilotReview(
            out.analysis.pageSemantics,
            validation,
            out.testCases,
            // L1-01: Pilot verdict now runs on the strong `reasoner` role (was the cheap `judge` tier) —
            // intended behavior change toward a "smart judge". See ADR-0011.
            router.invoke("reasoner", router.tierFor("reasoner", cfg.models.reasoning)),
            prompts,
            sessionLog,
          );
          onProgress(`pilot — verdict: ${pilot.verdict} — ${pilot.reason}`);
        } catch {
          // pilot is not critical
        }

        const cost = router.ledger.report(); // L1-01: per-role cost + tokens for this run
        const budgetReport: BudgetReport = { used: budget.spent, max: budget.max }; // L1-04 (Box 3)
        const stoppedEarly = Boolean(out.stoppedEarly); // L1-04 (Box 2)
        const flowReport = flowReportPayload(out.flowGraph, out.journeys, out.setupPlans); // #59/#60: graph + journeys + setup

        // #61: coverage view (always — a read-only set-difference); --gaps additionally suggests cases.
        const coveragePages = out.flowGraph
          ? out.flowGraph.nodes.map((n) => ({ url: n.url, elements: n.verified }))
          : [{ url: out.study.url, elements: out.verified }];
        const coverage = computeCoverage({
          pages: coveragePages,
          edges: out.flowGraph?.edges ?? [],
          testCases: out.testCases,
          journeys: out.journeys,
        });
        let gapCases: TestCase[] = [];
        if (input.gaps) {
          const topGaps = coverage.byPage.flatMap((p) => p.gaps).slice(0, 12); // bound cost
          if (topGaps.length > 0) {
            onProgress(`gaps — suggesting cases for ${topGaps.length} untested element(s) (worker)…`);
            try {
              gapCases = await designGapCases(
                { gaps: topGaps, pageSemantics: out.analysis.pageSemantics, language: languageText },
                { invoke: router.invoke("worker", router.tierFor("worker", cfg.models.bulk)), prompts },
              );
            } catch {
              // best-effort — the coverage view still ships without suggestions
            }
          }
        }

        // #39: also emit ATC/MTC case docs (.md) — explore now produces the human-readable cases like
        // design, so manual MTC cases are visible deliverables (not just buried inside report.md).
        const caseSuite = suiteFromUrl(out.study.url);
        const caseDocs = buildTestCaseDocs(out.testCases, out.verified, caseSuite, checklistItems.length > 0);
        const testCaseFiles = await runWriter.writeTestCases(caseDocs.docs);
        onProgress(
          `explore — wrote ${testCaseFiles.length} cases: ${caseDocs.autoN} ATC, ${caseDocs.manualN} MTC → testcases/`,
        );

        await runWriter.writeStudy(out.study);
        if (out.study.screenshotB64) await runWriter.writeScreenshot(out.study.screenshotB64);
        await runWriter.writeAria(out.study.ariaYaml);
        // #103: persist a per-page aria/screenshot for every crawled flow node (not just the start page).
        if (out.flowGraph) {
          await runWriter.writeFlowSnapshots(
            out.flowGraph.nodes.map((n, i) => ({
              dir: flowSnapshotPath(i, n.url),
              ariaYaml: n.study.ariaYaml,
              screenshotB64: n.study.screenshotB64,
            })),
          );
        }
        await runWriter.writeReport({
          runId,
          url: out.study.url,
          pageSemantics: out.analysis.pageSemantics,
          testCases: out.testCases,
          validation,
          scores,
          pilot,
          cost,
          budget: budgetReport,
          stoppedEarly,
          critique: out.critique, // #82: prune/top-up delta (undefined when the pass didn't run)
          flow: flowReport, // #59: page/flow graph + journey cases (undefined for single-page runs)
          coverage, // #61: covered vs observed-but-untested surface
          ...(gapCases.length ? { gapCases } : {}),
          history: {
            priorRuns: priorRuns.length,
            bestPriorGreen: bestPriorGreen ?? null,
            allTimePassing,
          },
        });
        await runWriter.writeReportMd(
          renderReportMd({
            runId,
            url: out.study.url,
            backend: cfg.browser.backend,
            profile: cfg.llmProfile,
            pageSemantics: out.analysis.pageSemantics,
            elements: out.study.elements,
            testCases: out.testCases,
            validation,
            scores,
            consoleErrors: out.study.consoleErrors,
            cost,
            budget: budgetReport,
            stoppedEarly,
            journeys: out.journeys,
            coverage,
            gapCases,
          }),
        );
        const green = validation ? `${Math.round(validation.greenRatio * 100)}%` : "—";
        await runWriter.writeLog(
          [...logLines, "", `summary: green=${green} testCases=${out.testCases.length} runId=${runId}`].join("\n"),
        );

        return {
          runId,
          runDir: runWriter.dir,
          study: out.study,
          analysis: out.analysis,
          testCases: out.testCases,
          suite,
          validation,
          scores,
          pilot,
          cost,
          budget: budgetReport,
          stoppedEarly,
          testCaseFiles,
          projectSpecFiles: ejected.projectSpecFiles,
          projectTestDir: ejected.projectTestDir,
        };
      },
    );

    return result;
  } catch (err) {
    // L1-04 (Box 1/3/4): the single failure path — write a partial report + a readable, actionable
    // summary, then throw a friendly Error. The user never sees a raw traceback or a silent halt.
    throw await finalizeFailure(runWriter, {
      runId,
      url: input.url,
      error: err,
      cost: router.ledger.report(),
      budget: { used: budget.spent, max: budget.max },
      sessionName: input.sessionName,
      onProgress,
    });
  } finally {
    await gateway.close();
    await telemetry.shutdown();
  }
}

export interface DesignResult {
  runId: string;
  runDir: string;
  study: PageStudy;
  analysis: PageAnalysis;
  testCases: TestCase[];
  testCaseFiles: string[];
  scores: Score[];
  /** Per-role cost + tokens for the run (L1-01). */
  cost: CostReport;
}

function suiteFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "page";
    return `${seg.replace(/[^a-z0-9]+/gi, "-").toUpperCase()}-UI`;
  } catch {
    return "PAGE-UI";
  }
}

/**
 * Design-only flow (Sprint: decoupled workflow): explore the page (observe+verify+multi-state+probe),
 * WRITE test cases in the user's format (testcases/ATC-*.md with selectors), WITHOUT codegen/validate.
 * Automation is a separate `automate` command.
 */
export async function runDesign(input: ExploreInput): Promise<DesignResult> {
  const cfg = input.config;
  // Onboarding guardrail: design drives the bundled Chromium to observe the page (skipped when a
  // system-browser channel is configured) → fail fast with a copy-paste fix before any LLM call.
  ensureBrowsersInstalled({ channel: cfg.browser.channel });
  const keys = { anthropicApiKey: cfg.anthropicApiKey, openrouterApiKey: cfg.openrouterApiKey, groqApiKey: cfg.groqApiKey };
  const budget = new CallBudget(80); // cost-guardrail: safeguard (normally ~6-10 calls/run)
  const logLines: string[] = [];
  // Parity with runExploration (#38): buffer progress into run.log, flushed incrementally so a
  // mid-run kill leaves the log on disk. `persistLog` is wired once the run dir exists.
  let persistLog: () => void = () => undefined; // no-op until the run dir exists
  const onProgress = (event: string): void => {
    logLines.push(`${new Date().toISOString()}  ${event}`);
    input.onProgress?.(event);
    persistLog();
  };

  const telemetry = await initTelemetry(cfg);
  const router = new RoleRouter(
    cfg,
    keys,
    budget,
    undefined,
    undefined,
    undefined,
    telemetry.callbackHandler ? [telemetry.callbackHandler] : undefined, // Task 2: thread handler into each LLM call
  ); // L1-01: per-role routing + cost ledger

  let storageState: StorageState | undefined;
  const sessionStore = new SessionStore(resolve(input.sessionsDir ?? ".auth"));
  if (input.sessionFile) storageState = await sessionStore.loadFile(resolve(input.sessionFile));
  // load() (not loadFile): actionable message on a missing named session, not a raw ENOENT (L1-05).
  else if (input.sessionName) storageState = await sessionStore.load(input.sessionName);

  const gateway = makeGateway({
    backend: cfg.browser.backend,
    storageState,
    channel: cfg.browser.channel,
    headless: !input.headed,
  });
  const prompts = new PromptRegistry();
  const artifacts = new ArtifactStore(resolve(input.runsBaseDir ?? defaultRunsBaseDir()));
  const runId = randomUUID();
  const runWriter = await artifacts.openRun(runId);
  // #38: now that the run dir exists, flush run.log on every progress event (best-effort).
  persistLog = () => void runWriter.writeLog(logLines.join("\n")).catch(() => undefined);

  const checklistItems = input.checklistText ? ingestChecklist(input.checklistText) : [];
  const knowledgeText = await loadKnowledge(resolve(input.knowledgeDir ?? "knowledge"), { url: input.url });
  // #93: cross-run page-understanding cache (keyed by url + page fingerprint) — a re-run on the same
  // page reuses it and skips the ground LLM call. Persist the artifact into the run dir too (durability).
  const understandingCacheDir = resolve(input.understandingCacheDir ?? ".cairn-cache/understanding");
  const onUnderstanding = (map: InteractionMap): void =>
    void runWriter.writeUnderstanding(map).catch(() => undefined);
  // `--fresh` skips this disk read entirely → no "previously STABLE cases" dedup block, so the run
  // generates a full set (clean A/B comparison) instead of only the delta vs. past runs of this URL.
  const experienceText = await experienceForUrl({
    runsBaseDir: resolve(input.runsBaseDir ?? defaultRunsBaseDir()),
    url: input.url,
    currentRunId: runId,
    fresh: input.fresh,
  });
  const styleText = input.styleText ?? styleDirective(input.style ?? "all");
  const languageText = input.language ?? cfg.testCaseLanguage;
  // L1-01: resolve per-role tiers (override ?? profile tier), then build metered invokers.
  const visionTier = cfg.models.vision ?? cfg.models.reasoning;
  const analyzeTier = router.tierFor("worker", visionTier);
  const designTier = router.tierFor("reasoner", cfg.models.reasoning);
  const codegenTier = router.tierFor("worker", cfg.models.bulk);

  const designDeps = {
    gateway,
    prompts,
    analyzeInvoke: router.invoke("worker", analyzeTier),
    designInvoke: router.invoke("reasoner", designTier),
    codegenInvoke: router.invoke("worker", codegenTier),
    // #82: self-critique runs on the worker tier (CAIRN_ROLE_WORKER) to bound cost; built only when opted in.
    critiqueInvoke: input.critique ? router.invoke("worker", codegenTier) : undefined,
    critique: input.critique,
    flow: input.flow,
    maxPages: input.maxPages,
    setup: input.setup,
    // #60: setup planning runs on the worker tier (CAIRN_ROLE_WORKER); built only when opted in.
    setupInvoke: input.setup ? router.invoke("worker", router.tierFor("worker", cfg.models.bulk)) : undefined,
    useVision: analyzeTier.supportsVision,
    understandingCacheDir,
    fresh: input.fresh,
    onUnderstanding,
    checklistText: formatChecklist(checklistItems),
    knowledgeText,
    experienceText,
    styleText,
    languageText,
    runWriter,
    validate: () => Promise.resolve({ results: [], greenRatio: 0, flakyCount: 0 }),
    maxRepair: 0,
    onProgress,
    // #38 parity with explore: persist study + snapshots the moment observe succeeds, so a mid-run
    // kill still leaves the page study/screenshot/ARIA on disk (best-effort — never break the run).
    onStudy: async (study: PageStudy) => {
      try {
        await runWriter.writeStudy(study);
        if (study.screenshotB64) await runWriter.writeScreenshot(study.screenshotB64);
        await runWriter.writeAria(study.ariaYaml);
      } catch {
        // durability is best-effort
      }
    },
    // Durability: design's loss window is small (END right after designTestCases), but still real — flush
    // the case docs the instant they are designed so an interrupt before the final write keeps them.
    onTestCases: async (testCases: TestCase[], verified: import("../browser/index.js").VerifiedElement[], studyUrl: string) => {
      try {
        const { docs } = buildTestCaseDocs(testCases, verified, suiteFromUrl(studyUrl), checklistItems.length > 0);
        await runWriter.writeTestCases(docs);
      } catch {
        // durability is best-effort
      }
    },
    codeless: true,
    // L1-05: a session was supplied → fail fast if the first page is a login screen (expired session).
    expectAuthenticated: Boolean(input.sessionName || input.sessionFile),
    sessionName: input.sessionName,
  };

  try {
    // Task 2: wrap in a root trace so nested LangChain CallbackHandler generations attach to ONE trace.
    // Fix 2: the entire post-graph evaluation (scores + judges + score-attach) runs INSIDE
    // the callback so judge LLM calls fire the handler while the root span is still active.
    const result = await telemetry.runInTrace(
      "design",
      { runId, backend: cfg.browser.backend, profile: cfg.llmProfile, mode: "design" },
      async () => {
        const out = await runExploreGraph(designDeps, { url: input.url, runId });

        // (Expired-session detection now fails fast inside the graph's identifyElements node — L1-05.)

        const suite = suiteFromUrl(out.study.url);
        const { docs, autoN, manualN } = buildTestCaseDocs(
          out.testCases,
          out.verified,
          suite,
          checklistItems.length > 0,
        );
        const testCaseFiles = await runWriter.writeTestCases(docs);
        onProgress(
          `design — wrote ${testCaseFiles.length} cases: ${autoN} auto/ATC, ${manualN} manual/MTC (${suite}) → testcases/`,
        );

        const scores: Score[] = deterministicScores({
          study: out.study,
          verified: out.verified,
          testCases: out.testCases,
        });
        try {
          scores.push(
            ...(await judgeTestCases(
              out.testCases,
              out.analysis.pageSemantics,
              router.invoke("judge", cfg.models.judge),
              prompts,
            )),
          );
        } catch {
          // judge optional
        }
        if (checklistItems.length > 0) {
          try {
            const cov = await judgeChecklistCoverage(
              checklistItems,
              out.testCases,
              router.invoke("judge", cfg.models.judge),
              prompts,
            );
            scores.push({ name: "checklist_coverage", value: cov.value, comment: cov.comment });
          } catch {
            scores.push({ name: "checklist_coverage", value: coverageScore(checklistItems, out.testCases) });
          }
        }

        await runWriter.writeStudy(out.study);
        if (out.study.screenshotB64) await runWriter.writeScreenshot(out.study.screenshotB64);
        await runWriter.writeAria(out.study.ariaYaml);
        // #103: persist a per-page aria/screenshot for every crawled flow node (not just the start page).
        if (out.flowGraph) {
          await runWriter.writeFlowSnapshots(
            out.flowGraph.nodes.map((n, i) => ({
              dir: flowSnapshotPath(i, n.url),
              ariaYaml: n.study.ariaYaml,
              screenshotB64: n.study.screenshotB64,
            })),
          );
        }
        // #61: coverage view (always) + optional gap-case suggestions (--gaps).
        const coveragePages = out.flowGraph
          ? out.flowGraph.nodes.map((n) => ({ url: n.url, elements: n.verified }))
          : [{ url: out.study.url, elements: out.verified }];
        const coverage = computeCoverage({
          pages: coveragePages,
          edges: out.flowGraph?.edges ?? [],
          testCases: out.testCases,
          journeys: out.journeys,
        });
        let gapCases: TestCase[] = [];
        if (input.gaps) {
          const topGaps = coverage.byPage.flatMap((p) => p.gaps).slice(0, 12);
          if (topGaps.length > 0) {
            try {
              gapCases = await designGapCases(
                { gaps: topGaps, pageSemantics: out.analysis.pageSemantics, language: languageText },
                { invoke: router.invoke("worker", router.tierFor("worker", cfg.models.bulk)), prompts },
              );
            } catch {
              // best-effort
            }
          }
        }

        const cost = router.ledger.report(); // L1-01: per-role cost + tokens for this run
        await runWriter.writeReport({
          runId,
          url: out.study.url,
          mode: "design",
          suite,
          pageSemantics: out.analysis.pageSemantics,
          testCases: out.testCases,
          testCaseFiles,
          scores,
          cost,
          critique: out.critique, // #82: prune/top-up delta (undefined when the pass didn't run)
          flow: flowReportPayload(out.flowGraph, out.journeys, out.setupPlans), // #59/#60: graph + journeys + setup
          coverage, // #61: covered vs observed-but-untested surface
          ...(gapCases.length ? { gapCases } : {}),
        });
        await runWriter.writeLog(
          [...logLines, "", `summary: mode=design testCases=${out.testCases.length} suite=${suite} runId=${runId}`].join("\n"),
        );

        return {
          runId,
          runDir: runWriter.dir,
          study: out.study,
          analysis: out.analysis,
          testCases: out.testCases,
          testCaseFiles,
          scores,
          cost,
        };
      },
    );

    return result;
  } catch (err) {
    // L1-04 parity with runExploration: write a partial report + a friendly, actionable summary
    // instead of leaking a raw traceback. Study/snapshots/log/cases were already persisted
    // incrementally (onStudy/persistLog/onTestCases), so the partial run is still useful on disk.
    throw await finalizeFailure(runWriter, {
      runId,
      url: input.url,
      error: err,
      cost: router.ledger.report(),
      budget: { used: budget.spent, max: budget.max },
      sessionName: input.sessionName,
      onProgress,
    });
  } finally {
    await gateway.close();
    await telemetry.shutdown();
  }
}

export interface AutomateResult {
  runDir: string;
  specFiles: string[];
  /** #51: the host project's testDir specs were ejected into (undefined in greenfield mode). */
  projectTestDir?: string;
  validation?: ValidationReport;
  /** Per-role cost + tokens for the codegen step(s) (L1-01). */
  cost: CostReport;
  /** Per-run LLM-call budget usage (L1-04, Box 3). */
  budget: BudgetReport;
  /** The repair loop bailed early because it stopped making progress (L1-04 #40). */
  stoppedEarly: boolean;
}

/**
 * `automate` command: from ready cases (runDir/testcases/*.md) → @playwright/test code in runDir/tests/.
 * The second half of the decoupled flow (design → automate). Optionally validates (requires a session).
 */
export async function runAutomate(input: {
  runDir: string;
  config: AppConfig;
  /** Base directory for runs/ (default ./runs) — used to resolve a bare run id passed as runDir. */
  runsBaseDir?: string;
  sessionName?: string;
  sessionFile?: string;
  sessionsDir?: string;
  validate?: boolean;
  /** #51: eject specs into an existing Playwright project's testDir instead of runDir/tests. */
  intoProject?: boolean;
  /** #51: explicit project dir for --into-project (detection searches from cwd upward when omitted). */
  projectDir?: string;
  /** #94 (BORROW-05): record a `.webm` per scenario during --validate (review-gate affordance). Default off. */
  screencast?: boolean;
  onProgress?: (event: string) => void;
}): Promise<AutomateResult> {
  const cfg = input.config;
  const keys = { anthropicApiKey: cfg.anthropicApiKey, openrouterApiKey: cfg.openrouterApiKey, groqApiKey: cfg.groqApiKey };
  const budget = new CallBudget(80); // cost-guardrail: safeguard (normally ~6-10 calls/run)
  const onProgress = input.onProgress ?? ((): void => undefined);
  // #40: automate now repairs (multiple codegen calls) → warn as it nears the budget, like explore.
  let warnedBudget = false;
  const onCharge = (used: number, max: number): void => {
    if (!warnedBudget && max > 0 && used / max >= 0.8) {
      warnedBudget = true;
      onProgress(`⚠ approaching the LLM-call budget (${used}/${max} calls — cost guardrail)`);
    }
  };
  const router = new RoleRouter(cfg, keys, budget, undefined, undefined, onCharge); // L1-01 routing + ledger
  const runDir = await resolveRunDir(input.runDir, { runsBaseDir: resolve(input.runsBaseDir ?? defaultRunsBaseDir()) });

  const rep = JSON.parse(await readFile(join(runDir, "report.json"), "utf8")) as {
    url?: string;
    pageSemantics?: string;
  };
  const baseUrl = rep.url ?? "";
  const pageSemantics = rep.pageSemantics ?? "";

  const tcDir = join(runDir, "testcases");
  const mdFiles = (await readdir(tcDir)).filter((f) => f.endsWith(".md"));
  const allCases: ReturnType<typeof parseTestCaseMd>[] = [];
  for (const f of mdFiles) allCases.push(parseTestCaseMd(await readFile(join(tcDir, f), "utf8")));
  // Only auto/ATC — manual/MTC cases are NOT automated (they are manual).
  const cases = allCases.filter((c) => c.execution !== "manual" && !c.id.startsWith("MTC"));
  const skipped = allCases.length - cases.length;
  onProgress(`automate — ${cases.length} auto cases (skipped manual/MTC: ${skipped}) from ${displayPath(tcDir)}`);

  const invoke = router.invoke("worker", router.tierFor("worker", cfg.models.bulk));
  const prompts = new PromptRegistry();
  const buildSuite = (repairHint?: string): Promise<GeneratedSuite> =>
    automateCases(cases, { baseUrl, pageSemantics }, { invoke, prompts }, repairHint);

  const artifacts = new ArtifactStore(dirname(runDir));
  const runWriter = await artifacts.openRun(basename(runDir));

  let sessionPath: string | undefined;
  if (input.sessionFile) sessionPath = resolve(input.sessionFile);
  else if (input.sessionName) {
    sessionPath = new SessionStore(resolve(input.sessionsDir ?? ".auth")).pathFor(input.sessionName);
  }

  let suite: GeneratedSuite;
  let validation: ValidationReport | undefined;
  let stoppedEarly = false;
  if (input.validate) {
    // Onboarding guardrail: validation runs the generated suite → fail fast with a copy-paste fix
    // before spending LLM calls on codegen. FIX B (0.3.3): pass the channel — skipped when a system
    // browser is configured (the bug: `automate --validate` fired this even with BROWSER_CHANNEL=chrome).
    ensureBrowsersInstalled({ channel: cfg.browser.channel });
    // #40: validate ⇄ repair ⇄ keep-best (+ no-progress early-stop) — the SAME convergence the explore
    // graph uses, instead of a single one-shot generation. Lifts the decoupled flow to explore-grade green.
    const result = await runRepairLoop({
      generate: async (hint) => {
        const s = await buildSuite(hint);
        await runWriter.writeSuite(s);
        return s;
      },
      validate: () => validateSuite(runWriter.dir, { storageStatePath: sessionPath, channel: cfg.browser.channel, workers: cfg.playwrightWorkers, screencast: input.screencast }),
      maxRepair: cfg.maxRepair,
      onProgress,
      lint: (s) => lintHint(lintSuite(s)), // #57: feed fragile-pattern findings into repair
    });
    suite = result.bestSuite;
    validation = result.bestValidation;
    stoppedEarly = result.stoppedEarly;
    onProgress(
      `automate — validation: ${Math.round(validation.greenRatio * 100)}% green${stoppedEarly ? " · stopped early (no progress)" : ""}`,
    );
  } else {
    suite = await buildSuite(); // single pass — repair needs validation to measure progress
  }

  // #51: eject into an existing Playwright project when requested; else write to runDir/tests as before.
  const ejected = await ejectToProjectIfRequested({
    intoProject: input.intoProject,
    projectDir: input.projectDir,
    suite,
    runWriter,
    onProgress,
  });
  let specFiles: string[];
  if (ejected.projectTestDir) {
    specFiles = ejected.projectSpecFiles ?? [];
  } else {
    specFiles = await runWriter.writeSuite(suite); // final/best suite on disk
    onProgress(`automate — ${specFiles.length} spec file(s) → tests/`);
  }

  const cost = router.ledger.report(); // L1-01: per-role cost + tokens for the codegen step(s)
  const budgetReport: BudgetReport = { used: budget.spent, max: budget.max };
  return { runDir: runWriter.dir, specFiles, projectTestDir: ejected.projectTestDir, validation, stoppedEarly, cost, budget: budgetReport };
}
