import type { TestResult } from "../../validate/index.js";
import { questionChars } from "../capabilities.js";
import type { Answer, Decider, Question } from "../types.js";

/**
 * repair-triage (spec §6.1, ADR-0022): why did a generated test fail? A confident "the app is broken" or
 * "the environment is broken" keeps the test out of the repair hint — repairing test code cannot fix
 * either — and the run reports it instead. Every other confident category only tags the hint.
 */
export type FailureCategory = "locator-ambiguous" | "locator-missing" | "timing" | "wrong-assertion" | "app-bug" | "env-or-session";

/**
 * label → when it applies. Sent as the choice's criteria: the descriptions are what the model decides by.
 * Short on purpose — the whole question must fit laya's 400-character question cap (capabilities.ts). A
 * "wrong result" belongs to wrong-assertion only: when it is unclear whose fault it is, repair it.
 */
export const FAILURE_CATEGORIES: Record<FailureCategory, string> = {
  "locator-ambiguous": "locator matched several elements (strict mode)",
  "locator-missing": "locator found no element, or it was hidden",
  timing: "page not ready yet: navigation, data, animation",
  "wrong-assertion": "page worked, but a different result was expected",
  "app-bug": "the app failed: server error, crash, error page",
  "env-or-session": "environment failed: session expired, server unreachable",
};

/** Categories a confident answer keeps out of repair — the only direction a decider may push (ADR-0020). */
const NOT_REPAIRABLE: ReadonlySet<string> = new Set(["app-bug", "env-or-session"]);

/** Playwright's own call log follows the cause; beyond this the tokens buy nothing (and cost money on jev). */
const MAX_STATE_CHARS = 2000;

export const TRIAGE_QUESTION: Question = {
  type: "choice",
  instructions: "Why did this Playwright test fail?",
  options: FAILURE_CATEGORIES,
};

export interface TriageResult {
  test: string;
  category: FailureCategory;
  confidence: number;
  /** true → left out of the repair hint and reported as not repaired. */
  exclude: boolean;
}

/** The test's name and its error, colour codes stripped, clipped to fit `maxChars` whole. */
export function triageState(r: TestResult, maxChars: number): string {
  const head = `Playwright test "${r.test}" failed.\nError:\n`;
  const error = (r.error ?? "(no error message)").replace(/\u001b\[[0-9;]*m/g, "").trim();
  const full = head + error;
  return full.length <= maxChars ? full : `${full.slice(0, maxChars - 1)}…`;
}

interface Asked {
  r: TestResult;
  state: string;
  latencyMs: number;
  /** The decider's category — absent when it was unavailable or answered outside the options. */
  c?: { category: FailureCategory; confidence: number };
  reason?: string;
}

function asCategory(a: Answer | undefined): { category: FailureCategory; confidence: number } | undefined {
  if (a?.type !== "choice" || !Object.hasOwn(FAILURE_CATEGORIES, a.value)) return undefined; // never trust an unoffered label
  return { category: a.value as FailureCategory, confidence: a.confidence };
}

/**
 * One call per failed test, each over its own state, run concurrently (a hanging server costs one timeout,
 * not one per test; the per-run ceiling still holds). Only a confident answer counts; a failure or a doubt
 * leaves the test in the hint exactly as today. Shadow mode records each answer next to "repair" and
 * returns nothing — so the loop runs as it would have without a decider.
 */
export function makeTriage(decider: Decider): (failed: TestResult[]) => Promise<TriageResult[]> {
  // The provider reads the state together with the question: the error gets what the question leaves.
  const maxChars = Math.min(decider.caps.maxInputChars - questionChars(TRIAGE_QUESTION), MAX_STATE_CHARS);
  return async (failed) => {
    const asked = await Promise.all(
      failed.map(async (r): Promise<Asked> => {
        const state = triageState(r, maxChars);
        const t0 = Date.now();
        try {
          const answers = await decider.decide("repair-triage", state, { cause: TRIAGE_QUESTION });
          const c = asCategory(answers.cause);
          return { r, state, latencyMs: Date.now() - t0, ...(c ? { c } : { reason: "an answer outside the offered categories" }) };
        } catch (e) {
          return { r, state, latencyMs: Date.now() - t0, reason: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    const confident = (c: { confidence: number }): boolean => c.confidence >= decider.minConfidence;
    if (decider.shadow) {
      for (const a of asked) {
        decider.shadow.record({
          use: "repair-triage",
          input: a.state,
          current: "repair",
          decider: a.c
            ? { category: a.c.category, confidence: a.c.confidence, wouldExclude: confident(a.c) && NOT_REPAIRABLE.has(a.c.category) }
            : { unavailable: a.reason },
          ...(a.c ? { confidence: a.c.confidence } : {}),
          latencyMs: a.latencyMs,
        });
      }
      return [];
    }
    return asked.flatMap((a) =>
      a.c && confident(a.c)
        ? [{ test: a.r.test, category: a.c.category, confidence: a.c.confidence, exclude: NOT_REPAIRABLE.has(a.c.category) }]
        : [],
    );
  };
}
