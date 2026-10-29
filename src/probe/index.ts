import type { BrowserGateway } from "../browser/index.js";
import type { ElementRef, ElementState } from "../browser/types.js";

/** An observed state transition after a safe action (act→observe). */
export interface Transition {
  ref: string;
  role: string;
  name?: string;
  before: ElementState;
  after: ElementState;
}

/** Reversible roles that are safe to click (restored by a reverse click). */
const SAFE_ROLES = new Set(["switch", "checkbox", "radio"]);

/** Convert transitions into text for the prompt (designer/codegen ground assertions on them). */
export function formatTransitions(transitions: Transition[]): string {
  if (transitions.length === 0) return "(no observed transitions — assertions on the static state only)";
  return transitions
    .map((t) => {
      const change =
        t.before.checked !== undefined && t.after.checked !== undefined
          ? `checked ${t.before.checked}→${t.after.checked}`
          : `enabled ${t.before.enabled}→${t.after.enabled}`;
      return `- click ${t.ref} (${t.role}${t.name ? ` "${t.name}"` : ""}): ${change}`;
    })
    .join("\n");
}

export interface ProbeOptions {
  /** Where the step says how far it got and what it skipped (the run's progress → run.log). */
  onProgress?: (event: string) => void;
  /** The most one act→observe may take; past it the element is skipped (#213). */
  elementTimeoutMs?: number;
  /** The most the whole step may take; past it the elements left are not probed (#213). */
  budgetMs?: number;
}

const ELEMENT_TIMEOUT_MS = 10_000;
const BUDGET_MS = 120_000;
/** A progress line every this many safe elements, so a slow step is seen to move. */
const PROGRESS_EVERY = 10;

class ProbeTimeout extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function probeOne(gateway: BrowserGateway, el: ElementRef): Promise<Transition | undefined> {
  const before = await gateway.getState(el);
  if (!before.visible || !before.enabled) return undefined; // don't touch hidden/disabled

  const clicked = await gateway.act({ kind: "click", ref: el.ref });
  if (!clicked.ok) return undefined;
  const after = await gateway.getState(el);
  await gateway.act({ kind: "click", ref: el.ref }).catch(() => undefined); // revert (reversibility)

  return { ref: el.ref, role: el.role, name: el.name, before, after };
}

/**
 * Stage B grounding: for safe (reversible) elements, perform a click, OBSERVE the state transition,
 * and revert it. Does NOT touch buttons (submit/delete), links (navigation), or file inputs.
 * Gives the designer real transitions instead of guessed ones → grounds state-transition assertions.
 *
 * #213: the step has an end. An element that does not answer within `elementTimeoutMs` is skipped and the
 * step stops at `budgetMs`, each said through `onProgress`, with a line every 10 elements.
 */
export async function probeTransitions(
  gateway: BrowserGateway,
  elements: ElementRef[],
  { onProgress, elementTimeoutMs = ELEMENT_TIMEOUT_MS, budgetMs = BUDGET_MS }: ProbeOptions = {},
): Promise<Transition[]> {
  const safe = elements.filter((el) => SAFE_ROLES.has(el.role));
  const started = Date.now();
  const out: Transition[] = [];
  for (const [i, el] of safe.entries()) {
    if (Date.now() - started >= budgetMs) {
      onProgress?.(`probeInteractions — stopped at the ${budgetMs} ms limit: ${i} of ${safe.length} safe elements tried`);
      break;
    }
    if (i > 0 && i % PROGRESS_EVERY === 0) onProgress?.(`probeInteractions — ${i} of ${safe.length} safe elements tried`);
    try {
      // ponytail: a skipped element's browser call is not cancelled - it finishes or fails on its own; the
      // next element reads the same page. Cancel it (an AbortSignal through the gateway) if it ever interferes.
      const transition = await within(probeOne(gateway, el), elementTimeoutMs);
      if (transition) out.push(transition);
    } catch (e) {
      if (!(e instanceof ProbeTimeout)) throw e;
      onProgress?.(`probeInteractions — skipped ${el.ref} (${el.role}${el.name ? ` "${el.name}"` : ""}): no answer in ${elementTimeoutMs} ms`);
    }
  }
  return out;
}
