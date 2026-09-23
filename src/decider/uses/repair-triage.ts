import type { TestResult } from "../../validate/index.js";
import type { Answer, Decider, Question } from "../types.js";

/**
 * repair-triage (spec §6.1, ADR-0022): why did a generated test fail? A confident "the app is broken" or
 * "the environment is broken" keeps the test out of the repair hint — repairing test code cannot fix
 * either — and the run reports it instead. Every other confident category only tags the hint.
 */
export type FailureCategory = "locator-ambiguous" | "locator-missing" | "timing" | "wrong-assertion" | "app-bug" | "env-or-session";

/** label → when it applies. Sent as the choice's criteria: the descriptions are what the model decides by. */
export const FAILURE_CATEGORIES: Record<FailureCategory, string> = {
  "locator-ambiguous": "The locator matched more than one element (a strict mode violation: resolved to N elements)",
  "locator-missing": "The locator matched no element: the element was not found, not visible or not attached",
  timing: "The page was not ready yet: a navigation, network response or animation had not finished when the step ran",
  "wrong-assertion": "The page worked, but the test expected a different text, value, count, state or URL",
  "app-bug": "The application itself misbehaved: a server error, a crash, a broken page or a wrong result for valid input",
  "env-or-session": "The environment failed: an expired session or a login page, an unreachable server, or a browser that did not start",
};

/** Categories a confident answer keeps out of repair — the only direction a decider may push (ADR-0020). */
const NOT_REPAIRABLE: ReadonlySet<string> = new Set(["app-bug", "env-or-session"]);

/** Playwright's own call log follows the cause; beyond this the tokens buy nothing (and cost money on jev). */
const MAX_STATE_CHARS = 2000;

const QUESTION: Question = {
  type: "choice",
  instructions: "Why did this generated Playwright test fail? Pick the most likely cause from its error message.",
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
  const maxChars = Math.min(decider.caps.maxStateChars, MAX_STATE_CHARS);
  return async (failed) => {
    const asked = await Promise.all(
      failed.map(async (r): Promise<Asked> => {
        const state = triageState(r, maxChars);
        const t0 = Date.now();
        try {
          const answers = await decider.decide("repair-triage", state, { cause: QUESTION });
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
