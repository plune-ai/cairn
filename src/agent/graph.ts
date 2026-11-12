import { capture, type PageStudy } from "../observe/index.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import { analyzePage, type PageAnalysis } from "../analyze/index.js";
import { designTestCases, type TestCase } from "../design/index.js";
import { critiqueCases, type CritiqueDelta } from "../design/critique.js";
import { crawlFlow, type FlowGraph } from "../flow/crawl.js";
import { designJourneys } from "../flow/journey.js";
import { planSetup, type SetupPlan } from "../flow/setup.js";
import { buildJourneySetupSuite } from "../codegen/journey-setup.js";
import type { JourneyCase } from "../design/schema.js";
import { generateSuite, type GeneratedSuite } from "../codegen/index.js";
import { probeTransitions, type Transition } from "../probe/index.js";
import { looksLikeLoginPage, expiredSessionMessage } from "../session/index.js";
import {
  fingerprintPage,
  loadUnderstanding,
  saveUnderstanding,
  buildInteractionMap,
  analysisFromMap,
  type InteractionMap,
} from "../documentarian/index.js";
import { findConsentDismiss, describeObserveError } from "./observe-guard.js";
import { runRepairLoop } from "./repair-loop.js";
import { lintErrors } from "../codegen/lint.js";
import { makeTriage, type TriageResult } from "../decider/uses/repair-triage.js";
import { makeHeal, type HealRecord } from "../decider/uses/locator-heal.js";
import type { Decider } from "../decider/types.js";
import type { ValidationReport } from "../validate/index.js";
import type { RunWriter } from "../artifacts/index.js";
import type { BlockedRequest, BrowserGateway, ClickEffect, VerifiedElement } from "../browser/index.js";
import type { AmbiguousFinding } from "../browser/types.js";
import { exploreOverlays, nameOverlays } from "./overlays.js";
import { formatOverlays, type OverlayState } from "../observe/overlays.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { StructuredInvoke } from "../llm/structured.js";

/** Graph dependencies — injected (real in runExploration, fake in tests). */
export interface ExploreDeps {
  gateway: BrowserGateway;
  prompts: PromptRegistry;
  analyzeInvoke: StructuredInvoke;
  designInvoke: StructuredInvoke;
  codegenInvoke: StructuredInvoke;
  /** #82: worker-tier invoker for the design-time self-critique pass. Absent → pass is skipped. */
  critiqueInvoke?: StructuredInvoke;
  /** #82: run the self-critique pass (prune + technique top-up). Conservative default: off. */
  critique?: boolean;
  /** #59: follow in-app navigation, build a page/flow graph, design multi-page journey cases. Opt-in. */
  flow?: boolean;
  /** #59: max pages to crawl when `flow` is on (page cap — cost guardrail). Default 1 (single page). */
  maxPages?: number;
  /** #60: plan + emit starting-state setup (fixtures / API seed) for journeys. Opt-in. */
  setup?: boolean;
  /** #60: worker-tier invoker for setup planning (precondition extraction). Absent → no setup. */
  setupInvoke?: StructuredInvoke;
  useVision: boolean;
  /** #63: pre-formatted goal directive ({@link formatGoal}) — biases observe (element pick) + design. "" → no bias. */
  goalText?: string;
  checklistText?: string;
  knowledgeText?: string;
  experienceText?: string;
  styleText?: string;
  languageText?: string;
  /** #230: the available API flows for design (`formatFlowsForPrompt`); absent → the design prompt is unchanged. */
  apiFlowsText?: string;
  runWriter: RunWriter;
  /** Runs and classifies an already-written suite (injected so the graph can be tested without a browser). */
  validate: (runDir: string) => Promise<ValidationReport>;
  maxRepair: number;
  /** Live per-node progress (for CLI/log). */
  onProgress?: (event: string) => void;
  /**
   * Called with the page study the moment `observe` succeeds (after any consent-wall dismissal) —
   * lets the caller persist study/snapshots immediately so a mid-run kill doesn't lose everything
   * (L1-04, #38). Best-effort: a throw here must not break the run.
   */
  onStudy?: (study: PageStudy) => void | Promise<void>;
  /**
   * Called with the freshly designed cases the moment `designTestCases` succeeds — mirrors onStudy
   * (#38) so an interrupt during the later codegen/validate phase doesn't lose the generated cases.
   * Best-effort: a throw here must not break the run. `studyUrl` lets the caller derive the SAME
   * suite label the final write uses, so the early and final writes produce identical files.
   */
  onTestCases?: (testCases: TestCase[], verified: VerifiedElement[], studyUrl: string) => void | Promise<void>;
  /**
   * #93: cross-run cache dir for the page-understanding artifact. When set, a run on a page whose
   * fingerprint matches a cached map REUSES it and skips the ground (analyzePage) LLM call. Undefined
   * → caching off (behavior unchanged). The dir is keyed internally by url + page fingerprint.
   */
  understandingCacheDir?: string;
  /** #93: ignore a cached understanding for this run (forces a fresh ground call). Mirrors `--fresh`. */
  fresh?: boolean;
  /**
   * #93: called with the freshly built interaction map (mirrors onStudy/onTestCases) so the caller can
   * persist it as the run's first-class artifact (page-understanding.json). Best-effort: a throw here
   * must not break the run.
   */
  onUnderstanding?: (map: InteractionMap) => void | Promise<void>;
  /** Codeless mode: stop after designTestCases (cases only, no codegen/validate). */
  codeless?: boolean;
  /**
   * A session was supplied → we EXPECT to land on an authenticated page. If the first page
   * looks like a login screen, fail fast with re-capture guidance instead of exploring it (L1-05).
   */
  expectAuthenticated?: boolean;
  /** Session name (for the expired-session message). */
  sessionName?: string;
  /** ADR-0022: the opt-in decision layer. Absent → every use point takes today's path. */
  decider?: Decider;
  /** #225: explore dialogs, drawers, menus and wizards as states. On unless `false`. */
  overlays?: boolean;
}

export interface ExploreOutcome {
  study: PageStudy;
  analysis: PageAnalysis;
  verified: VerifiedElement[];
  transitions: Transition[];
  testCases: TestCase[];
  suite?: GeneratedSuite;
  validation?: ValidationReport;
  bestSuite?: GeneratedSuite;
  bestValidation?: ValidationReport;
  stoppedEarly: boolean;
  /** Repair attempts actually run (0 = green on the first try, or maxRepair=0 or codeless). */
  attempts: number;
  /** #82: before/after delta of the self-critique pass (undefined when the pass didn't run). */
  critique?: CritiqueDelta;
  /** #59: the page/flow graph crawled when `flow` is on (undefined for single-page runs). */
  flowGraph?: FlowGraph;
  /** #59: multi-page journey cases designed from the graph (undefined for single-page runs). */
  journeys?: JourneyCase[];
  /** #60: per-journey structured setup plans (undefined unless `setup` ran). */
  setupPlans?: SetupPlan[];
  /** ADR-0022: failures repair-triage kept out of repair (absent unless something was). */
  notRepaired?: TriageResult[];
  /** ADR-0022: locator replacements proposed in the kept suite's repair hint (absent unless one was). */
  healed?: HealRecord[];
  /** #224: what every click of this exploration did, in order (empty on the cli backend, which records none). */
  clicks: ClickEffect[];
  /** #226: elements nothing told apart from others like it (same role and name in their scope): not clicked. `[]` when none. */
  ambiguous?: AmbiguousFinding[];
  /** #225: the overlays found as states (absent when the step did not run or failed; `[]` when it ran and found none). */
  overlays?: OverlayState[];
  /** #225: controls exploration left alone (destructive, completing a form, over the limit), and toast texts seen. */
  overlaySkipped?: { role: string; name?: string; reason: string }[];
  overlayToasts?: string[];
  /**
   * #225 review 3: whether the write guard was on while overlays were explored (`none`: nothing was pressed, and
   * `note` says why), and the writes it stopped, each with the element pressed before it.
   */
  overlayGuard?: { guard: "network" | "none"; blocked: BlockedRequest[]; note?: string };
}

/** #224: the same gateway, keeping the effect of every click made through it. */
function recordingClicks(gateway: BrowserGateway, clicks: ClickEffect[], ambiguous: AmbiguousFinding[]): BrowserGateway {
  let page = "";
  /** #226: once per page, role, name and scope: the same element is met again by every revisit. */
  const note = (found: Omit<AmbiguousFinding, "page">): void => {
    const key = (f: Omit<AmbiguousFinding, "page">, p: string): string => `${p}\u0000${f.role}\u0000${f.name ?? ""}\u0000${f.scope?.role ?? ""}\u0000${f.scope?.name ?? ""}`;
    if (!ambiguous.some((a) => key(a, a.page) === key(found, page))) ambiguous.push({ page, ...found });
  };
  return {
    observe: async (opts) => {
      const obs = await gateway.observe(opts);
      page = obs.url;
      return obs;
    },
    act: async (action) => {
      const result = await gateway.act(action);
      if (result.effect) clicks.push(result.effect);
      if (result.ambiguous) note(result.ambiguous);
      return result;
    },
    verify: async (elements) => {
      const verified = await gateway.verify(elements);
      for (const v of verified) {
        if (v.ambiguous && v.interactive) note({ role: v.role, ...(v.name !== undefined ? { name: v.name } : {}), count: v.count, ...(v.scope ? { scope: v.scope } : {}) });
      }
      return verified;
    },
    getState: async (element) => {
      const state = await gateway.getState(element);
      // #252: an overlay's buttons are only read, never verified: one nothing tells apart is a finding all the same
      if (state.ambiguous !== undefined && element.interactive) {
        note({ role: element.role, ...(element.name !== undefined ? { name: element.name } : {}), count: state.ambiguous, ...(element.scope ? { scope: element.scope } : {}) });
      }
      return state;
    },
    // #225 review 3: the network guard passes through, or exploreOverlays would think the backend has none
    ...(gateway.guardWrites ? { guardWrites: () => gateway.guardWrites!() } : {}),
    session: () => gateway.session(),
    runTests: (globs) => gateway.runTests(globs),
    close: () => gateway.close(),
  };
}

/** Sprint 3: observe → identify → design → generateCode → validate ⇄ repair (bounded by maxRepair). */
export async function runExploreGraph(
  deps: ExploreDeps,
  init: { url: string; runId: string },
): Promise<ExploreOutcome> {
  const { url } = init;
  const clicks: ClickEffect[] = [];
  const ambiguous: AmbiguousFinding[] = [];
  deps = { ...deps, gateway: recordingClicks(deps.gateway, clicks, ambiguous) }; // every node below clicks through it

  // ── observe ──────────────────────────────────────────────────────────────
  deps.onProgress?.("observe — opening browser + navigating…");
  let study: PageStudy;
  try {
    study = await capture(deps.gateway, url);
  } catch (e) {
    // can't proceed: navigation/observe failed → a readable one-liner, never a raw stack (Box 1).
    const line = describeObserveError(e, url);
    deps.onProgress?.(`observe — ${line}`);
    throw new Error(line);
  }
  // best-effort: decline an obvious cookie/consent wall BEFORE studying the page (privacy-
  // preserving default — Box 1). A failed dismissal is non-fatal: keep the original study.
  const consent = findConsentDismiss(study.elements);
  if (consent) {
    try {
      deps.onProgress?.(`observe — dismissing consent wall ("${consent.name ?? consent.ref}")`);
      const clicked = await deps.gateway.act({ kind: "click", ref: consent.ref });
      if (clicked.ok) study = await capture(deps.gateway, ""); // re-observe (no re-navigation)
    } catch {
      // consent dismissal is best-effort — continue with what we already have.
    }
  }
  // #38: persist the study/snapshots NOW (best-effort) so a later kill still leaves them on disk.
  try {
    await deps.onStudy?.(study);
  } catch {
    // durability is best-effort — never let it break the run.
  }
  deps.onProgress?.(`observe — done: ${study.elements.length} elements, screenshot taken`);

  // ── documentarian: reuse cached page-understanding when the page is unchanged (#93) ──────────
  // The fingerprint is the ARIA hash → an identical page reuses its cached map and SKIPS the ground
  // (analyzePage) LLM call; a changed page misses and re-grounds (deliberate invalidation).
  const fingerprint = fingerprintPage(study);
  const cached =
    deps.understandingCacheDir && !deps.fresh
      ? await loadUnderstanding(deps.understandingCacheDir, study.url, fingerprint)
      : undefined;

  // ── identifyElements ──────────────────────────────────────────────────────
  let analysis: PageAnalysis;
  if (cached) {
    analysis = analysisFromMap(cached, new Set(study.elements.map((e) => e.ref)));
    deps.onProgress?.("documentarian — cache HIT: reusing page understanding (skipped ground LLM call)");
  } else {
    deps.onProgress?.("identifyElements — page analysis (LLM)…");
    analysis = await analyzePage(study, {
      invoke: deps.analyzeInvoke,
      prompts: deps.prompts,
      vision: deps.useVision,
      goalText: deps.goalText,
    });
  }
  // L1-05: a session was supplied but the first page looks like a login screen → the session
  // is likely expired. Fail fast with re-capture guidance BEFORE the expensive design/codegen
  // steps, instead of silently exploring the sign-in page.
  if (
    deps.expectAuthenticated &&
    looksLikeLoginPage(
      analysis.pageSemantics,
      study.elements.map((e) => e.name ?? ""),
    )
  ) {
    deps.onProgress?.("⚠ first page looks like LOGIN — session likely expired; failing fast.");
    throw new Error(expiredSessionMessage(deps.sessionName));
  }
  deps.onProgress?.(`identifyElements — ${analysis.primaryRefs.length} key elements`);

  // ── verifyLocators ────────────────────────────────────────────────────────
  deps.onProgress?.(`verifyLocators — checking ${study.elements.length} locators…`);
  let verified: VerifiedElement[];
  try {
    verified = await deps.gateway.verify(study.elements);
  } catch (e) {
    // degrade (Box 1): verification failed → continue with unverified locators instead of crashing.
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    deps.onProgress?.(`verifyLocators — skipped (verification failed: ${msg})`);
    verified = study.elements.map((el) => ({ ...el, count: -1, verified: false }));
  }
  deps.onProgress?.(
    `verifyLocators — usable ${verified.filter((v) => v.verified).length}/${verified.length}`,
  );

  // ── exploreStates ─────────────────────────────────────────────────────────
  if (analysis.viewSwitchers.length > 0) {
    const byRef = new Map(study.elements.map((e) => [e.ref, e]));
    const seen = new Set(verified.map((v) => `${v.role} ${v.name ?? ""}`));
    const merged: VerifiedElement[] = [...verified];
    let added = 0;
    for (const sw of analysis.viewSwitchers.slice(0, 4)) {
      const swEl = byRef.get(sw);
      if (!swEl) continue;
      try {
        deps.onProgress?.(`exploreStates — view: ${swEl.name ?? sw}`);
        await deps.gateway.observe({ url }); // reset to state-0 (refs valid again)
        const clicked = await deps.gateway.act({ kind: "click", ref: sw });
        if (!clicked.ok) continue;
        const obs = await deps.gateway.observe({}); // state after switching
        const fresh = parseAriaSnapshot(obs.ariaSnapshot).filter(
          (e) => e.interactive && !seen.has(`${e.role} ${e.name ?? ""}`),
        );
        const verifiedFresh = await deps.gateway.verify(fresh);
        for (const v of verifiedFresh) {
          if (v.count >= 1) {
            seen.add(`${v.role} ${v.name ?? ""}`);
            merged.push({ ...v, viaSwitcher: { role: swEl.role, name: swEl.name } });
            added += 1;
          }
        }
      } catch {
        // the switcher didn't work — skip it (additive, without breaking the base flow)
      }
    }
    await deps.gateway.observe({ url }).catch(() => undefined); // return to state-0
    deps.onProgress?.(
      `exploreStates — added ${added} elements from ${analysis.viewSwitchers.length} views`,
    );
    verified = merged;
  }

  // ── exploreOverlays (#225) ────────────────────────────────────────────────
  // Dialogs, drawers, menus and wizards as states: what opens them, what is in them, how they close. Best effort: a
  // failure keeps the page-level run intact.
  let overlays: OverlayState[] | undefined;
  let overlaySkipped: ExploreOutcome["overlaySkipped"];
  let overlayToasts: string[] | undefined;
  let overlayGuard: ExploreOutcome["overlayGuard"];
  if (deps.overlays !== false) {
    deps.onProgress?.("exploreOverlays — opening dialogs, drawers and menus…");
    try {
      const found = await exploreOverlays({ gateway: deps.gateway, url, study, onProgress: deps.onProgress });
      overlays = await nameOverlays(
        found.states,
        { pageSemantics: analysis.pageSemantics, language: deps.languageText },
        { invoke: deps.analyzeInvoke, prompts: deps.prompts },
      );
      overlaySkipped = found.skipped;
      overlayToasts = found.toasts;
      overlayGuard = { guard: found.guard, blocked: found.blocked, ...(found.note ? { note: found.note } : {}) };
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      deps.onProgress?.(`exploreOverlays — skipped (${msg})`);
    }
    // back to state-0. #252: also a new document for the crawler: reading the session for the write guard
    // (storageState with IndexedDB) left Playwright's database connections open in the old one, where they would
    // block an upgrade the app makes. No way to close them from here; a load ends them.
    await deps.gateway.observe({ url }).catch(() => undefined);
  }
  const overlayText = formatOverlays(overlays ?? []);

  // ── probeInteractions ─────────────────────────────────────────────────────
  deps.onProgress?.("probeInteractions — act→observe of safe elements…");
  const transitions = await probeTransitions(
    deps.gateway,
    verified.filter((v) => v.verified),
    deps.onProgress ? { onProgress: deps.onProgress } : {},
  );
  deps.onProgress?.(`probeInteractions — transitions observed: ${transitions.length}`);

  // ── documentarian: build + cache + persist the reusable interaction map (#93) ─────────────────
  // Deterministic assembly from this run's observe/ground/verify/probe outputs — no extra LLM call.
  // Always refreshed (even on a cache hit) so a re-run keeps the artifact current.
  const interactionMap = buildInteractionMap(study, analysis, verified, transitions, fingerprint);
  if (deps.understandingCacheDir) await saveUnderstanding(deps.understandingCacheDir, interactionMap);
  try {
    await deps.onUnderstanding?.(interactionMap);
  } catch {
    // persisting the artifact is best-effort — never let it break the run.
  }
  deps.onProgress?.(
    `documentarian — interaction map: ${interactionMap.elements.length} elements (${cached ? "reused" : "fresh"} understanding)`,
  );

  // ── designTestCases ───────────────────────────────────────────────────────
  deps.onProgress?.("designTestCases — designing cases (LLM reasoning, may take ~a minute)…");
  let testCases = await designTestCases(
    {
      study,
      pageSemantics: analysis.pageSemantics,
      checklistText: deps.checklistText,
      goalText: deps.goalText,
      elements: verified.filter((v) => v.count >= 1),
      transitions,
      overlays: overlayText,
      knowledge: deps.knowledgeText,
      experience: deps.experienceText,
      style: deps.styleText,
      language: deps.languageText,
      apiFlows: deps.apiFlowsText,
    },
    { invoke: deps.designInvoke, prompts: deps.prompts },
  );
  deps.onProgress?.(`designTestCases — generated ${testCases.length} cases`);

  // ── critique (opt-in, #82) ────────────────────────────────────────────────
  // One cheap worker-tier pass that prunes weak cases + tops up under-represented techniques.
  // Best-effort: a critique failure must never sink a run that already has a valid design set.
  let critique: CritiqueDelta | undefined;
  if (deps.critique && deps.critiqueInvoke && testCases.length > 0) {
    deps.onProgress?.("critique — pruning weak cases + topping up technique gaps (worker)…");
    try {
      const out = await critiqueCases(
        {
          testCases,
          pageSemantics: analysis.pageSemantics,
          knownRefs: verified.filter((v) => v.count >= 1).map((v) => v.ref),
          language: deps.languageText,
        },
        { invoke: deps.critiqueInvoke, prompts: deps.prompts },
      );
      testCases = out.cases;
      critique = out.delta;
      deps.onProgress?.(
        `critique — pruned ${critique.pruned}, topped up ${critique.toppedUp}; ` +
          `technique coverage ${critique.techniqueCoverageBefore.toFixed(2)}→${critique.techniqueCoverageAfter.toFixed(2)}`,
      );
    } catch {
      // critique is best-effort — keep the original design set on any failure.
    }
  }
  // Durability: persist the cases NOW (best-effort), mirroring onStudy (#38) — a kill during the later
  // codegen/validate phase (minutes for explore) must not lose what we already designed.
  try {
    await deps.onTestCases?.(testCases, verified, study.url);
  } catch {
    // durability is best-effort — never let it break the run.
  }

  // ── flow exploration (opt-in, #59) ────────────────────────────────────────
  // Crawl in-app navigation → page/flow graph → multi-page journey cases. Runs AFTER per-page design
  // so single-page output is unchanged; best-effort so a crawl failure can't sink the per-page cases.
  let flowGraph: FlowGraph | undefined;
  let journeys: JourneyCase[] | undefined;
  let setupPlans: SetupPlan[] | undefined;
  if (deps.flow && (deps.maxPages ?? 1) > 1) {
    deps.onProgress?.(`flow — crawling up to ${deps.maxPages} pages (reusing the session)…`);
    try {
      const startNode = { url: study.url, study, verified: verified.filter((v) => v.count >= 1), transitions };
      flowGraph = await crawlFlow(startNode, { gateway: deps.gateway, onProgress: deps.onProgress }, { maxPages: deps.maxPages ?? 1 });
      deps.onProgress?.(`flow — graph: ${flowGraph.nodes.length} pages, ${flowGraph.edges.length} transitions`);
      journeys = await designJourneys(
        { graph: flowGraph, language: deps.languageText },
        { invoke: deps.designInvoke, prompts: deps.prompts },
      );
      deps.onProgress?.(`flow — ${journeys.length} journey case(s) spanning ≥2 pages`);

      // #60: plan the starting-state setup per journey + emit runnable journey specs (fixtures / seed).
      if (deps.setup && deps.setupInvoke && journeys.length > 0) {
        deps.onProgress?.("flow — planning starting-state setup for journeys (worker)…");
        setupPlans = [];
        for (const j of journeys) {
          try {
            setupPlans.push(
              await planSetup({ journey: j, pageSemantics: analysis.pageSemantics }, { invoke: deps.setupInvoke, prompts: deps.prompts }),
            );
          } catch {
            setupPlans.push({ preconditions: [] }); // a planning failure → an empty (no-precondition) spec
          }
        }
        try {
          const suite = buildJourneySetupSuite(journeys, setupPlans, flowGraph, study.url);
          const written = await deps.runWriter.writeJourneySpecs(suite.files);
          deps.onProgress?.(`flow — wrote ${written.length} journey spec(s) with setup → journeys/`);
        } catch {
          // best-effort: a write failure must not sink the run
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      deps.onProgress?.(`flow — skipped (${msg})`); // best-effort: keep the per-page cases
    }
  }

  const overlayKeys = (): Pick<ExploreOutcome, "overlays" | "overlaySkipped" | "overlayToasts" | "overlayGuard"> => ({
    ...(overlays ? { overlays } : {}),
    ...(overlaySkipped ? { overlaySkipped } : {}),
    ...(overlayToasts ? { overlayToasts } : {}),
    ...(overlayGuard ? { overlayGuard } : {}),
  });

  // ── codeless short-circuit ────────────────────────────────────────────────
  if (deps.codeless) {
    return { study, analysis, verified, transitions, testCases, stoppedEarly: false, attempts: 0, critique, flowGraph, journeys, setupPlans, clicks, ambiguous, ...overlayKeys() };
  }

  // ── generate → validate → repair (reuse runRepairLoop) ───────────────────
  const genAndWrite = async (repairHint?: string): Promise<GeneratedSuite> => {
    const suite = await generateSuite(
      {
        study,
        pageSemantics: analysis.pageSemantics,
        testCases,
        repairHint,
        elements: verified.filter((v) => v.count >= 1),
        transitions,
        overlays: overlayText,
      },
      { invoke: deps.codegenInvoke, prompts: deps.prompts },
    );
    await deps.runWriter.writeSuite(suite);
    return suite;
  };

  // locator-heal re-observes the start page on the run's own browser; nothing reads the page after this loop.
  const heal = deps.decider?.uses.has("locator-heal") ? makeHeal({ decider: deps.decider, gateway: deps.gateway, url }) : undefined;
  const { bestSuite, bestValidation, stoppedEarly, attempts, notRepaired, healed } = await runRepairLoop({
    generate: async (hint) => {
      const suite = await genAndWrite(hint);
      deps.onProgress?.(`generateCode — ${suite.files.length} spec files written`);
      return suite;
    },
    validate: async () => {
      deps.onProgress?.("validate — running the generated tests (playwright)…");
      const v = await deps.validate(deps.runWriter.dir);
      deps.onProgress?.(`validate — ${Math.round(v.greenRatio * 100)}% green out of ${v.results.length} tests`);
      return v;
    },
    maxRepair: deps.maxRepair,
    onProgress: deps.onProgress,
    errors: (s) => lintErrors(s, verified), // #226: pointer clicks, forced clicks and blind positions; #279: locators that are not one visible element; repaired before the run
    triage: deps.decider?.uses.has("repair-triage") ? makeTriage(deps.decider, heal) : undefined,
    heal,
  });

  return {
    study,
    analysis,
    verified,
    transitions,
    testCases,
    suite: bestSuite,
    validation: bestValidation,
    bestSuite,
    bestValidation,
    stoppedEarly,
    attempts,
    critique,
    flowGraph,
    journeys,
    setupPlans,
    ...(notRepaired ? { notRepaired } : {}),
    ...(healed ? { healed } : {}),
    clicks,
    ambiguous,
    ...overlayKeys(),
  };
}
