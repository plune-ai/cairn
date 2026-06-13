import { randomUUID } from "node:crypto";
import { resolve, dirname, basename, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { makeGateway } from "../browser/index.js";
import { RoleRouter, type CostReport } from "../llm/index.js";
import { CallBudget } from "../llm/structured.js";
import { PromptRegistry } from "../prompts/index.js";
import { initTelemetry } from "../telemetry/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { renderReportMd } from "../artifacts/report.js";
import { parseTestCaseMd } from "../artifacts/testcase-md.js";
import { automateCases } from "../codegen/index.js";
import { deterministicScores, type Score } from "../eval/scorers.js";
import { judgeTestCases, judgeChecklistCoverage } from "../eval/judge.js";
import { pilotReview, type PilotVerdict } from "../eval/pilot.js";
import { collectPriorRuns, unionPassedTitles, formatExperience } from "../eval/collect.js";
import { ingestChecklist, formatChecklist, coverageScore, styleDirective } from "../checklist/index.js";
import { loadKnowledge } from "../knowledge/index.js";
import { validateSuite, type ValidationReport } from "../validate/index.js";
import { SessionStore } from "../session/index.js";
import { buildExploreGraph } from "./graph.js";
import { finalizeFailure } from "./finalize.js";
import { runRepairLoop } from "./repair-loop.js";
import { buildTestCaseDocs } from "./testcase-docs.js";
import type { BudgetReport } from "./summary.js";
import type { AppConfig } from "../config/index.js";
import type { StorageState } from "../browser/index.js";
import type { PageStudy } from "../observe/index.js";
import type { PageAnalysis } from "../analyze/index.js";
import type { TestCase } from "../design/index.js";
import type { GeneratedSuite } from "../codegen/index.js";

export { buildExploreGraph, ExploreState } from "./graph.js";
export type { ExploreDeps } from "./graph.js";

export interface ExploreInput {
  url: string;
  config: AppConfig;
  checklistText?: string;
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
  /** Planning style: happy | negative | coverage | all (default all). */
  style?: string;
  /** Test-case language (override; otherwise cfg.testCaseLanguage / env QA_TESTCASE_LANG / "English"). */
  language?: string;
  /** Visible browser (debug). */
  headed?: boolean;
  /** Live per-node progress (CLI prints to stderr). */
  onProgress?: (event: string) => void;
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
}

/**
 * End-to-end exploration → methodological cases → runnable @playwright/test → validation/repair (MVP, Sprint 3).
 * Artifacts land in runsBaseDir/<runId>/; everything is traced in Langfuse.
 */
export async function runExploration(input: ExploreInput): Promise<ExploreResult> {
  const cfg = input.config;
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
  const router = new RoleRouter(cfg, keys, budget, undefined, undefined, onCharge); // L1-01: routing + cost ledger

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
  const telemetry = initTelemetry(cfg);
  const prompts = new PromptRegistry();
  const artifacts = new ArtifactStore(resolve(input.runsBaseDir ?? resolve(process.cwd(), "runs")));
  const runId = randomUUID();
  const runWriter = await artifacts.openRun(runId);
  // #38: now that the run dir exists, flush run.log on every progress event (best-effort).
  persistLog = () => void runWriter.writeLog(logLines.join("\n")).catch(() => undefined);

  // Checklist (Sprint 4): a human narrows down WHAT to test → steers the design + measures coverage.
  const checklistItems = input.checklistText ? ingestChecklist(input.checklistText) : [];
  const checklistFormatted = formatChecklist(checklistItems);
  const knowledgeText = await loadKnowledge(resolve(input.knowledgeDir ?? "knowledge"), input.url);
  const experienceText = formatExperience(
    unionPassedTitles(
      (
        await collectPriorRuns(resolve(input.runsBaseDir ?? resolve(process.cwd(), "runs")), input.url)
      ).filter((r) => r.runId !== runId),
    ),
  );
  const styleText = styleDirective(input.style ?? "all");
  const languageText = input.language ?? cfg.testCaseLanguage;

  // L1-01: resolve per-role tiers (override ?? profile tier), then build metered invokers.
  const visionTier = cfg.models.vision ?? cfg.models.reasoning;
  const analyzeTier = router.tierFor("worker", visionTier);
  const designTier = router.tierFor("reasoner", cfg.models.reasoning);
  const codegenTier = router.tierFor("worker", cfg.models.bulk);
  const graph = buildExploreGraph({
    gateway,
    prompts,
    analyzeInvoke: router.invoke("worker", analyzeTier),
    designInvoke: router.invoke("reasoner", designTier),
    codegenInvoke: router.invoke("worker", codegenTier),
    useVision: analyzeTier.supportsVision,
    checklistText: checklistFormatted,
    knowledgeText,
    experienceText,
    styleText,
    languageText,
    runWriter,
    validate: (runDir) => validateSuite(runDir, { storageStatePath: sessionPath }),
    maxRepair: cfg.maxRepair,
    onProgress,
    // #38: persist study + snapshots the moment observe succeeds, so a mid-run kill still leaves
    // the page study/screenshot/ARIA on disk (best-effort — never break the run).
    onStudy: async (study) => {
      try {
        await runWriter.writeStudy(study);
        if (study.screenshotB64) await runWriter.writeScreenshot(study.screenshotB64);
        await runWriter.writeAria(study.ariaYaml);
      } catch {
        // durability is best-effort
      }
    },
    // L1-05: a session was supplied → fail fast if the first page is a login screen (expired session).
    expectAuthenticated: Boolean(input.sessionName || input.sessionFile),
    sessionName: input.sessionName,
  });

  try {
    const out = await graph.invoke(
      { url: input.url, runId },
      {
        callbacks: telemetry.callbackHandler ? [telemetry.callbackHandler] : [],
        runName: "exploration",
        metadata: { runId, backend: cfg.browser.backend, profile: cfg.llmProfile },
      },
    );
    if (!out.study || !out.analysis) throw new Error("The graph did not return study/analysis.");

    // (Expired-session detection now fails fast inside the graph's identifyElements node — L1-05.)

    // keep-best: final = the BEST suite/validation across all attempts (repair could not make it worse).
    const suite = out.bestSuite ?? out.suite;
    const validation = out.bestValidation ?? out.validation;
    if (out.bestSuite) await runWriter.writeSuite(out.bestSuite); // restore the best code on disk

    // Phase 4: study prior runs of this URL + collect the best (collect-best).
    const runsBase = resolve(input.runsBaseDir ?? resolve(process.cwd(), "runs"));
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
      pilot = await pilotReview(
        out.analysis.pageSemantics,
        validation,
        out.testCases,
        // L1-01: Pilot verdict now runs on the strong `reasoner` role (was the cheap `judge` tier) —
        // intended behavior change toward a "smart judge". See ADR-0011.
        router.invoke("reasoner", router.tierFor("reasoner", cfg.models.reasoning)),
        prompts,
      );
      onProgress(`pilot — verdict: ${pilot.verdict} — ${pilot.reason}`);
    } catch {
      // pilot is not critical
    }

    const cost = router.ledger.report(); // L1-01: per-role cost + tokens for this run
    const budgetReport: BudgetReport = { used: budget.spent, max: budget.max }; // L1-04 (Box 3)
    const stoppedEarly = Boolean(out.stoppedEarly); // L1-04 (Box 2)

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
    };
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
  const keys = { anthropicApiKey: cfg.anthropicApiKey, openrouterApiKey: cfg.openrouterApiKey, groqApiKey: cfg.groqApiKey };
  const budget = new CallBudget(80); // cost-guardrail: safeguard (normally ~6-10 calls/run)
  const router = new RoleRouter(cfg, keys, budget); // L1-01: per-role routing + cost ledger
  const logLines: string[] = [];
  const onProgress = (event: string): void => {
    logLines.push(`${new Date().toISOString()}  ${event}`);
    input.onProgress?.(event);
  };

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
  const telemetry = initTelemetry(cfg);
  const prompts = new PromptRegistry();
  const artifacts = new ArtifactStore(resolve(input.runsBaseDir ?? resolve(process.cwd(), "runs")));
  const runId = randomUUID();
  const runWriter = await artifacts.openRun(runId);

  const checklistItems = input.checklistText ? ingestChecklist(input.checklistText) : [];
  const knowledgeText = await loadKnowledge(resolve(input.knowledgeDir ?? "knowledge"), input.url);
  const experienceText = formatExperience(
    unionPassedTitles(
      (
        await collectPriorRuns(resolve(input.runsBaseDir ?? resolve(process.cwd(), "runs")), input.url)
      ).filter((r) => r.runId !== runId),
    ),
  );
  const styleText = styleDirective(input.style ?? "all");
  const languageText = input.language ?? cfg.testCaseLanguage;
  // L1-01: resolve per-role tiers (override ?? profile tier), then build metered invokers.
  const visionTier = cfg.models.vision ?? cfg.models.reasoning;
  const analyzeTier = router.tierFor("worker", visionTier);
  const designTier = router.tierFor("reasoner", cfg.models.reasoning);
  const codegenTier = router.tierFor("worker", cfg.models.bulk);

  const graph = buildExploreGraph({
    gateway,
    prompts,
    analyzeInvoke: router.invoke("worker", analyzeTier),
    designInvoke: router.invoke("reasoner", designTier),
    codegenInvoke: router.invoke("worker", codegenTier),
    useVision: analyzeTier.supportsVision,
    checklistText: formatChecklist(checklistItems),
    knowledgeText,
    experienceText,
    styleText,
    languageText,
    runWriter,
    validate: () => Promise.resolve({ results: [], greenRatio: 0, flakyCount: 0 }),
    maxRepair: 0,
    onProgress,
    codeless: true,
    // L1-05: a session was supplied → fail fast if the first page is a login screen (expired session).
    expectAuthenticated: Boolean(input.sessionName || input.sessionFile),
    sessionName: input.sessionName,
  });

  try {
    const out = await graph.invoke(
      { url: input.url, runId },
      {
        callbacks: telemetry.callbackHandler ? [telemetry.callbackHandler] : [],
        runName: "design",
        metadata: { runId, backend: cfg.browser.backend, profile: cfg.llmProfile, mode: "design" },
      },
    );
    if (!out.study || !out.analysis) throw new Error("The graph did not return study/analysis.");

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
  } finally {
    await gateway.close();
    await telemetry.shutdown();
  }
}

export interface AutomateResult {
  runDir: string;
  specFiles: string[];
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
  sessionName?: string;
  sessionFile?: string;
  sessionsDir?: string;
  validate?: boolean;
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
  const runDir = resolve(input.runDir);

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
  onProgress(`automate — ${cases.length} auto cases (skipped manual/MTC: ${skipped}) from ${tcDir}`);

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
    // #40: validate ⇄ repair ⇄ keep-best (+ no-progress early-stop) — the SAME convergence the explore
    // graph uses, instead of a single one-shot generation. Lifts the decoupled flow to explore-grade green.
    const result = await runRepairLoop({
      generate: async (hint) => {
        const s = await buildSuite(hint);
        await runWriter.writeSuite(s);
        return s;
      },
      validate: () => validateSuite(runWriter.dir, { storageStatePath: sessionPath }),
      maxRepair: cfg.maxRepair,
      onProgress,
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

  const specFiles = await runWriter.writeSuite(suite); // final/best suite on disk
  onProgress(`automate — ${specFiles.length} spec file(s) → tests/`);

  const cost = router.ledger.report(); // L1-01: per-role cost + tokens for the codegen step(s)
  const budgetReport: BudgetReport = { used: budget.spent, max: budget.max };
  return { runDir: runWriter.dir, specFiles, validation, stoppedEarly, cost, budget: budgetReport };
}
