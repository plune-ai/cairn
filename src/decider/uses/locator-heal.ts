/**
 * locator-heal (spec §6.6, ADR-0022), v1: after a test fails on a locator, propose a verified replacement in the
 * repair hint. The generated spec stays plain `@playwright/test` — healing happens after the failure, never inside
 * the code. Code reads the broken locator out of Playwright's error and narrows the page's elements to the ones a
 * healer may offer — the same or a compatible role, never a destructive one; the decider only picks among them, and
 * its pick counts only when the browser finds exactly one such element.
 */
import type { BrowserGateway } from "../../browser/gateway.js";
import type { ElementRef } from "../../browser/types.js";
import { DESTRUCTIVE } from "../../flow/crawl.js";
import { parseAriaSnapshot } from "../../observe/parse-aria.js";
import { isDeletionIntent } from "../../safety/guardrails.js";
import type { TestResult } from "../../validate/index.js";
import { checkCaps } from "../capabilities.js";
import type { Decider, Question } from "../types.js";
import type { FailureCategory, TriageResult } from "./repair-triage.js";

export interface BrokenLocator {
  role: string;
  name?: string;
  /** The `getByRole(…)` text as the error printed it — what the repair hint tells the LLM to replace. */
  source: string;
}

/** `getByRole('role')` or `getByRole('role', { name: 'Name'[, exact: true] })`, with ' or " quotes. */
const GET_BY_ROLE =
  /getByRole\((['"])([a-z]+)\1(?:,\s*\{\s*name:\s*(['"])((?:\\.|(?!\3)[^\\\n])*)\3(?:,\s*exact:\s*(?:true|false))?\s*\})?\)/;

/** A locator expression. The first one in an error is the one that failed. */
const ANY_LOCATOR = /\b(?:getBy[A-Z]\w*|locator|frameLocator)\(/;

/**
 * The locator a failing test waited for. Nothing to heal from a CSS locator, a regex name, or a chained scope
 * (`getByRole('dialog').getByRole(…)`): a candidate from the whole page may sit outside the scope, and `verify`
 * counts matches on the whole page. A trailing `.first()`, `.last()` or `.nth(i)` is kept out of `source`.
 * Only the first locator in the error counts: a strict-mode violation goes on to list each element it resolved to,
 * with an `aka getByRole(…)` hint that is not the locator that failed.
 */
export function parseBrokenLocator(error: string): BrokenLocator | undefined {
  const text = error.replace(/\u001b\[[0-9;]*m/g, ""); // Playwright colours its output
  const m = GET_BY_ROLE.exec(text);
  if (!m || ANY_LOCATOR.exec(text)?.index !== m.index) return undefined;
  const after = text.slice(m.index + m[0].length);
  if (text[m.index - 1] === "." || /^\.(?!first\(\)|last\(\)|nth\()/.test(after)) return undefined;
  const name = m[4]?.replace(/\\(.)/g, "$1");
  return { role: m[2]!, ...(name !== undefined ? { name } : {}), source: m[0] };
}

/** Roles one element can be swapped for without changing what the step does. */
const ROLE_FAMILIES: readonly (readonly string[])[] = [
  ["textbox", "searchbox", "combobox"],
  ["checkbox", "switch"],
  ["menuitem", "menuitemcheckbox", "menuitemradio"],
];

export function compatibleRoles(role: string): ReadonlySet<string> {
  return new Set(ROLE_FAMILIES.find((f) => f.includes(role)) ?? [role]);
}

/**
 * The elements a healer may offer for a broken locator: interactive, named, of a compatible role, one per role and
 * name. Never one the crawler would refuse to click (`DESTRUCTIVE`) or that reads as deleting data — safety rules
 * are not optional (spec §3.5), so the decider is never even asked about them.
 */
export function healCandidates(aria: string, broken: BrokenLocator): ElementRef[] {
  const roles = compatibleRoles(broken.role);
  const seen = new Set<string>();
  return parseAriaSnapshot(aria).filter((e) => {
    const name = e.name?.trim();
    if (!e.interactive || !name || !roles.has(e.role)) return false;
    if (DESTRUCTIVE.test(name) || isDeletionIntent(name)) return false;
    const key = `${e.role}\n${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const quote = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The exact locator the repair hint proposes: `getByRole('button', { name: 'Save', exact: true })`. */
export function locatorText(el: { role: string; name: string }): string {
  return `getByRole(${quote(el.role)}, { name: ${quote(el.name)}, exact: true })`;
}

/** All a healer does with a browser: load the page, count matches. */
export type HealGateway = Pick<BrowserGateway, "observe" | "verify">;

/**
 * A gateway opened on first use and closed with the run: `automate` has no browser of its own, and most runs never
 * heal anything. A browser that fails to open fails that heal (a fallback), never the run's final `close`.
 */
export function lazyGateway(open: () => Promise<BrowserGateway>): HealGateway & { close(): Promise<void> } {
  let gw: Promise<BrowserGateway> | undefined;
  const get = (): Promise<BrowserGateway> => (gw ??= open());
  return {
    observe: async (o) => (await get()).observe(o),
    verify: async (els) => (await get()).verify(els),
    close: async () => {
      await gw?.then(
        (g) => g.close(),
        () => undefined,
      );
    },
  };
}

/** A proposal for the repair hint: the broken locator and a replacement verified to match one element. */
export interface HealRecord {
  test: string;
  /** The broken `getByRole(…)`, as the error printed it. */
  from: string;
  to: string;
  confidence: number;
}

/** Only what triage called a locator failure is healed (spec §6.6 step 1). */
const HEALABLE: ReadonlySet<FailureCategory> = new Set(["locator-missing", "locator-ambiguous"]);
const NONE = "none-of-these";
const PICK_INSTRUCTIONS = "Which element on the page did the failing locator mean?";
const SCORE_LEVELS = ["Unrelated to the failing step", "Plausible", "Clearly the element the step meant"];
/** The failure in one line. With a question of at most 400 chars (laya) it stays inside every provider's input cap. */
const MAX_STATE_CHARS = 500;
/** The two-stage path (spec §6.6, laya): at most the ten best-scored candidates go into the final choice. */
const MAX_FINALISTS = 10;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

interface Offered {
  el: ElementRef;
  label: string;
  /** `role "name"` as the decider sees it: scrubbed, then clipped to fit one option. */
  text: string;
}

/**
 * The healer (spec §6.6). Candidates come from the page as it loads now, not as it was when the test failed: a
 * locator reachable only mid-scenario finds no candidate, or none the decider picks, and goes to repair as today.
 * No verdict, no parse, the cli backend, no candidate, a doubt, a pick that does not match exactly one element, or
 * any failure → undefined, and repair runs as it would have without a decider. Shadow mode asks and verifies,
 * records, and proposes nothing.
 */
export function makeHeal(opts: {
  decider: Decider;
  /** The lib backend's. The cli one counts no matches (`count -1`), so there a heal asks nothing. */
  gateway: HealGateway;
  url: string;
}): (failure: TestResult, triage: TriageResult) => Promise<HealRecord | undefined> {
  const { decider, gateway, url } = opts;
  const { caps } = decider;
  // ponytail: room for labels up to "c999: " — a page with more candidates would still be refused whole, by checkCaps.
  const room = caps.maxOptionChars - 6;
  const choice = (offered: readonly Offered[]): Question => ({
    type: "choice",
    instructions: PICK_INSTRUCTIONS,
    options: { ...Object.fromEntries(offered.map((o) => [o.label, o.text])), [NONE]: "the element it meant is not in this list" },
  });
  const fits = (state: string, q: Question): boolean => {
    try {
      checkCaps(caps, state, { pick: q });
      return true;
    } catch {
      return false;
    }
  };
  /** Too many candidates for one choice: score each, in calls of at most `maxQuestionsPerCall`, keep the best that fit. */
  const shortlist = async (state: string, offered: readonly Offered[]): Promise<Offered[]> => {
    const score = new Map<string, number>();
    for (let i = 0; i < offered.length; i += caps.maxQuestionsPerCall) {
      const chunk = offered.slice(i, i + caps.maxQuestionsPerCall);
      const questions = Object.fromEntries(
        chunk.map((o): [string, Question] => [
          o.label,
          { type: "score", instructions: `How well does ${o.text} match the element the failing locator meant?`, levels: SCORE_LEVELS },
        ]),
      );
      const answers = await decider.decide("locator-heal", state, questions);
      for (const o of chunk) {
        const a = answers[o.label];
        if (a?.type === "score") score.set(o.label, a.value);
      }
    }
    const ranked = [...offered].sort((a, b) => (score.get(b.label) ?? -1) - (score.get(a.label) ?? -1)); // stable: ties keep page order
    const finalists: Offered[] = [];
    for (const o of ranked) {
      if (finalists.length === MAX_FINALISTS || !fits(state, choice([...finalists, o]))) break;
      finalists.push(o);
    }
    return finalists;
  };

  /** One broken locator, asked about for the first test that failed on it. */
  const heal = async (
    failure: TestResult,
    category: FailureCategory,
    broken: BrokenLocator,
  ): Promise<{ to: string; confidence: number } | undefined> => {
    const input = { state: "", candidates: [] as string[] };
    // The decider's time alone, as the other use points record it: opening the page and the check are not in it.
    let asked = 0;
    let answered = 0;
    // A no-op for an active decider, so every path below returns through it.
    const record = (d: unknown, confidence?: number): undefined => {
      decider.shadow?.record({
        use: "locator-heal",
        input,
        current: "repair",
        decider: d,
        ...(confidence !== undefined ? { confidence } : {}),
        latencyMs: asked ? (answered || Date.now()) - asked : 0,
      });
      return undefined;
    };
    try {
      const what = category === "locator-ambiguous" ? "matched several elements" : "matched no element";
      // The locator first: a clip cuts the tail, and a long test name must not cut what the decider picks by.
      input.state = clip(decider.scrub(`Locator ${broken.source} ${what} in Playwright test "${failure.test}".`), MAX_STATE_CHARS);
      const { ariaSnapshot, capturedBy } = await gateway.observe({ url });
      if (capturedBy !== "lib") return undefined; // the cli backend counts no matches: no pick could be checked
      const offered = healCandidates(ariaSnapshot, broken).map(
        (el, i): Offered => ({ el, label: `c${i + 1}`, text: clip(decider.scrub(`${el.role} "${el.name}"`), room) }),
      );
      if (offered.length === 0) return undefined; // nothing to ask about
      input.candidates = offered.map((o) => o.text);
      asked = Date.now();
      const finalists = fits(input.state, choice(offered)) ? offered : await shortlist(input.state, offered);
      const a = (await decider.decide("locator-heal", input.state, { pick: choice(finalists) })).pick;
      answered = Date.now();
      if (a?.type !== "choice") throw new Error("an answer of the wrong type");
      if (a.value === NONE) return record({ to: null, confidence: a.confidence }, a.confidence);
      const chosen = finalists.find((o) => o.label === a.value);
      if (!chosen) throw new Error(`an answer outside the offered candidates: '${a.value}'`); // never trust an unoffered label
      if (!decider.shadow && a.confidence < decider.minConfidence) return undefined;
      const [v] = await gateway.verify([chosen.el]);
      const to = locatorText({ role: chosen.el.role, name: chosen.el.name ?? "" });
      if (decider.shadow) return record({ to, confidence: a.confidence, verified: v?.count === 1 }, a.confidence);
      return v?.count === 1 ? { to, confidence: a.confidence } : undefined;
    } catch (e) {
      return record({ unavailable: e instanceof Error ? e.message : String(e) });
    }
  };

  // Tests that fail on one locator share one heal: the same page, question, check and answer, asked once (a renamed
  // login button can fail every test). ponytail: a single heal still costs ceil(candidates / maxQuestionsPerCall) + 1
  // calls on a page too big for one choice; DECIDER_MAX_CALLS bounds the run, cap the candidates if pilots meet such pages.
  const heals = new Map<string, ReturnType<typeof heal>>();
  return async (failure, triage) => {
    if (!HEALABLE.has(triage.category)) return undefined;
    const broken = parseBrokenLocator(failure.error ?? "");
    if (!broken) return undefined;
    const key = `${triage.category}\n${broken.source}`;
    let proposal = heals.get(key);
    if (!proposal) heals.set(key, (proposal = heal(failure, triage.category, broken)));
    const p = await proposal;
    return p && { test: failure.test, from: broken.source, ...p };
  };
}
