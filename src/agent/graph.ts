import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { capture, type PageStudy } from "../observe/index.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import { analyzePage, type PageAnalysis } from "../analyze/index.js";
import { designTestCases, type TestCase } from "../design/index.js";
import { generateSuite, type GeneratedSuite } from "../codegen/index.js";
import { probeTransitions, type Transition } from "../probe/index.js";
import { looksLikeLoginPage, expiredSessionMessage } from "../session/index.js";
import { progressSnapshot, madeProgress, type ProgressSnapshot } from "./progress.js";
import { findConsentDismiss, describeObserveError } from "./observe-guard.js";
import { failedTestsHint } from "./repair-loop.js";
import type { ValidationReport } from "../validate/index.js";
import type { RunWriter } from "../artifacts/index.js";
import type { BrowserGateway, VerifiedElement } from "../browser/index.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { StructuredInvoke } from "../llm/structured.js";

/** Graph dependencies — injected (real in runExploration, fake in tests). */
export interface ExploreDeps {
  gateway: BrowserGateway;
  prompts: PromptRegistry;
  analyzeInvoke: StructuredInvoke;
  designInvoke: StructuredInvoke;
  codegenInvoke: StructuredInvoke;
  useVision: boolean;
  checklistText?: string;
  knowledgeText?: string;
  experienceText?: string;
  styleText?: string;
  languageText?: string;
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
  /** Codeless mode: stop after designTestCases (cases only, no codegen/validate). */
  codeless?: boolean;
  /**
   * A session was supplied → we EXPECT to land on an authenticated page. If the first page
   * looks like a login screen, fail fast with re-capture guidance instead of exploring it (L1-05).
   */
  expectAuthenticated?: boolean;
  /** Session name (for the expired-session message). */
  sessionName?: string;
}

export const ExploreState = Annotation.Root({
  url: Annotation<string>,
  runId: Annotation<string>,
  study: Annotation<PageStudy | undefined>,
  analysis: Annotation<PageAnalysis | undefined>,
  verified: Annotation<VerifiedElement[]>({ default: () => [], reducer: (_, next) => next }),
  transitions: Annotation<Transition[]>({ default: () => [], reducer: (_, next) => next }),
  testCases: Annotation<TestCase[]>({ default: () => [], reducer: (_, next) => next }),
  suite: Annotation<GeneratedSuite | undefined>,
  validation: Annotation<ValidationReport | undefined>,
  attempts: Annotation<number>({ default: () => 0, reducer: (_, next) => next }),
  // keep-best: the best suite across all attempts (repair never makes things worse).
  bestSuite: Annotation<GeneratedSuite | undefined>,
  bestValidation: Annotation<ValidationReport | undefined>,
  bestGreen: Annotation<number>({ default: () => -1, reducer: (_, next) => next }),
  // No-progress detection (L1-04, Box 2): the previous attempt's snapshot + whether we bailed early.
  prevSnapshot: Annotation<ProgressSnapshot | undefined>,
  stoppedEarly: Annotation<boolean>({ default: () => false, reducer: (_, next) => next }),
});

type S = typeof ExploreState.State;

/** Sprint 3: observe → identify → design → generateCode → validate ⇄ repair (bounded by maxRepair). */
export function buildExploreGraph(deps: ExploreDeps) {
  const genAndWrite = async (s: S, repairHint?: string): Promise<GeneratedSuite> => {
    if (!s.study || !s.analysis) throw new Error("no study/analysis for codegen");
    const suite = await generateSuite(
      {
        study: s.study,
        pageSemantics: s.analysis.pageSemantics,
        testCases: s.testCases,
        repairHint,
        elements: s.verified.filter((v) => v.count >= 1),
        transitions: s.transitions,
      },
      { invoke: deps.codegenInvoke, prompts: deps.prompts },
    );
    await deps.runWriter.writeSuite(suite);
    return suite;
  };

  const routeAfterValidate = (s: S): "repair" | "done" => {
    if (s.bestGreen >= 1) return "done"; // fully green (by the BEST, not the latest) — done
    if (s.stoppedEarly) return "done"; // no-progress — bail early instead of burning maxRepair (Box 2)
    if (s.attempts < deps.maxRepair) return "repair";
    return "done";
  };

  return new StateGraph(ExploreState)
    .addNode("observe", async (s) => {
      deps.onProgress?.("observe — opening browser + navigating…");
      let study: PageStudy;
      try {
        study = await capture(deps.gateway, s.url);
      } catch (e) {
        // can't proceed: navigation/observe failed → a readable one-liner, never a raw stack (Box 1).
        const line = describeObserveError(e, s.url);
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
      return { study };
    })
    .addNode("identifyElements", async (s) => {
      deps.onProgress?.("identifyElements — page analysis (LLM)…");
      if (!s.study) throw new Error("observe did not produce study");
      const analysis = await analyzePage(s.study, {
        invoke: deps.analyzeInvoke,
        prompts: deps.prompts,
        vision: deps.useVision,
      });
      // L1-05: a session was supplied but the first page looks like a login screen → the session
      // is likely expired. Fail fast with re-capture guidance BEFORE the expensive design/codegen
      // steps, instead of silently exploring the sign-in page.
      if (
        deps.expectAuthenticated &&
        looksLikeLoginPage(
          analysis.pageSemantics,
          s.study.elements.map((e) => e.name ?? ""),
        )
      ) {
        deps.onProgress?.("⚠ first page looks like LOGIN — session likely expired; failing fast.");
        throw new Error(expiredSessionMessage(deps.sessionName));
      }
      deps.onProgress?.(`identifyElements — ${analysis.primaryRefs.length} key elements`);
      return { analysis };
    })
    .addNode("verifyLocators", async (s) => {
      if (!s.study) throw new Error("no study");
      deps.onProgress?.(`verifyLocators — checking ${s.study.elements.length} locators…`);
      let verified: VerifiedElement[];
      try {
        verified = await deps.gateway.verify(s.study.elements);
      } catch (e) {
        // degrade (Box 1): verification failed → continue with unverified locators instead of crashing.
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        deps.onProgress?.(`verifyLocators — skipped (verification failed: ${msg})`);
        verified = s.study.elements.map((el) => ({ ...el, count: -1, verified: false }));
      }
      deps.onProgress?.(
        `verifyLocators — usable ${verified.filter((v) => v.verified).length}/${verified.length}`,
      );
      return { verified };
    })
    .addNode("exploreStates", async (s) => {
      if (!s.study || !s.analysis || s.analysis.viewSwitchers.length === 0) return {};
      const byRef = new Map(s.study.elements.map((e) => [e.ref, e]));
      const seen = new Set(s.verified.map((v) => `${v.role} ${v.name ?? ""}`));
      const merged: VerifiedElement[] = [...s.verified];
      let added = 0;
      for (const sw of s.analysis.viewSwitchers.slice(0, 4)) {
        const swEl = byRef.get(sw);
        if (!swEl) continue;
        try {
          deps.onProgress?.(`exploreStates — view: ${swEl.name ?? sw}`);
          await deps.gateway.observe({ url: s.url }); // reset to state-0 (refs valid again)
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
      await deps.gateway.observe({ url: s.url }).catch(() => undefined); // return to state-0
      deps.onProgress?.(
        `exploreStates — added ${added} elements from ${s.analysis.viewSwitchers.length} views`,
      );
      return { verified: merged };
    })
    .addNode("probeInteractions", async (s) => {
      deps.onProgress?.("probeInteractions — act→observe of safe elements…");
      const transitions = await probeTransitions(deps.gateway, s.verified.filter((v) => v.verified));
      deps.onProgress?.(`probeInteractions — transitions observed: ${transitions.length}`);
      return { transitions };
    })
    .addNode("designTestCases", async (s) => {
      deps.onProgress?.("designTestCases — designing cases (LLM reasoning, may take ~a minute)…");
      if (!s.study || !s.analysis) throw new Error("no study/analysis");
      const testCases = await designTestCases(
        {
          study: s.study,
          pageSemantics: s.analysis.pageSemantics,
          checklistText: deps.checklistText,
          elements: s.verified.filter((v) => v.count >= 1),
          transitions: s.transitions,
          knowledge: deps.knowledgeText,
          experience: deps.experienceText,
          style: deps.styleText,
          language: deps.languageText,
        },
        { invoke: deps.designInvoke, prompts: deps.prompts },
      );
      deps.onProgress?.(`designTestCases — generated ${testCases.length} cases`);
      // Durability: persist the cases NOW (best-effort), mirroring onStudy (#38) — a kill during the later
      // codegen/validate phase (minutes for explore) must not lose what we already designed.
      try {
        await deps.onTestCases?.(testCases, s.verified, s.study.url);
      } catch {
        // durability is best-effort — never let it break the run.
      }
      return { testCases };
    })
    .addNode("generateCode", async (s) => {
      deps.onProgress?.("generateCode — generating @playwright/test (LLM)…");
      const suite = await genAndWrite(s);
      deps.onProgress?.(`generateCode — ${suite.files.length} spec files written`);
      return { suite };
    })
    .addNode("validate", async (s) => {
      deps.onProgress?.("validate — running the generated tests (playwright)…");
      const validation = await deps.validate(deps.runWriter.dir);
      deps.onProgress?.(
        `validate — ${Math.round(validation.greenRatio * 100)}% green out of ${validation.results.length} tests`,
      );
      // No-progress detection (Box 2): if this attempt did not improve on the previous one (same green
      // ratio AND the same failing tests), bail early instead of burning the rest of maxRepair.
      const snap = progressSnapshot(validation);
      const noProgress = !madeProgress(s.prevSnapshot, snap);
      if (noProgress) {
        deps.onProgress?.("validate — stopped early: no progress vs the previous attempt (same failing tests).");
      }
      // keep-best: accept only if BETTER and not broken (≥1 test). Otherwise keep the previous best.
      const better = validation.results.length > 0 && validation.greenRatio > s.bestGreen;
      if (!better && s.bestGreen >= 0) {
        deps.onProgress?.(
          `validate — not better than the best (${Math.round(s.bestGreen * 100)}%) → keeping the best`,
        );
      }
      return better
        ? {
            validation,
            prevSnapshot: snap,
            stoppedEarly: noProgress,
            bestSuite: s.suite,
            bestValidation: validation,
            bestGreen: validation.greenRatio,
          }
        : { validation, prevSnapshot: snap, stoppedEarly: noProgress };
    })
    .addNode("repair", async (s) => {
      deps.onProgress?.(`repair — self-repair (attempt ${s.attempts + 1})`);
      const failed = failedTestsHint(s.validation?.results ?? []);
      const suite = await genAndWrite(s, failed);
      return { suite, attempts: s.attempts + 1 };
    })
    .addEdge(START, "observe")
    .addEdge("observe", "identifyElements")
    .addEdge("identifyElements", "verifyLocators")
    .addEdge("verifyLocators", "exploreStates")
    .addEdge("exploreStates", "probeInteractions")
    .addEdge("probeInteractions", "designTestCases")
    .addConditionalEdges("designTestCases", () => (deps.codeless ? "done" : "code"), {
      code: "generateCode",
      done: END,
    })
    .addEdge("generateCode", "validate")
    .addConditionalEdges("validate", routeAfterValidate, { repair: "repair", done: END })
    .addEdge("repair", "validate")
    .compile();
}
