import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { BrowserGateway } from "../browser/gateway.js";
import type { BlockedRequest, ElementRef, ElementState, Observation, OverlayScope, WriteGuard } from "../browser/types.js";
import type { PageStudy } from "../observe/index.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import {
  EXIT_ORDER,
  formatOverlays,
  isBackName,
  isCompletionName,
  isStepName,
  overlayElements,
  overlayExits,
  overlayStack,
  passesSafetyFilters,
  toastTexts,
  wizardButtons,
  type OverlayExit,
  type OverlayState,
  type OverlayView,
  type WizardInfo,
  type WizardStep,
} from "../observe/overlays.js";

/**
 * #225: overlays as explore states. From the page, press what could open a dialog, a drawer or a menu; for each one
 * found, record what opened it, what is in it, its exits (Esc and a click outside are probed, the buttons are read),
 * the nested overlays it opens, and the steps of a wizard. Detection is the ARIA snapshot's (`observe/overlays.ts`);
 * no LLM here.
 *
 * The invariant (#225 reviews 3, 4): exploring overlays changes nothing on the server, whatever the button is called:
 * not while it runs, not after it ends. Every press happens under the backend's write guard, in a throwaway browser
 * that aborts every request but GET, HEAD and OPTIONS and is discarded, guard on, in `finally`; what it stopped is in
 * the result. A backend that cannot guard the network (cli), or a guard that did not start, presses no trigger and no
 * wizard step: it reads the overlays already open and says so. With nothing to press, no guard is started at all.
 *
 * On top of the guard, checks that do not depend on a name, for every press (triggers, nested probes, Next, Back): an
 * element that submits a form is not pressed, nor a disabled one. A trigger must say it opens something
 * (`aria-haspopup`, `aria-expanded` or `aria-controls`). Names keep only the deletion and sign-out deny-list — a
 * sign-out or a deletion link is often a GET, which the guard lets through — and the completions (Save, Submit…).
 */

export interface ExploreOverlaysInput {
  gateway: BrowserGateway;
  /** The page to explore; re-opened to reset between triggers. */
  url: string;
  /** The page as it is with nothing open: its elements are the triggers, its snapshot the baseline. */
  study: PageStudy;
  onProgress?: (event: string) => void;
  /** The most triggers pressed on the page (cost guardrail). */
  maxTriggers?: number;
}

export interface ExploreOverlaysResult {
  states: OverlayState[];
  /** Controls that were left alone, and why. */
  skipped: { role: string; name?: string; reason: string }[];
  /** Toast and validation texts seen anywhere, in order, once each. */
  toasts: string[];
  /** `network`: the write guard was on for every press. `none`: no guard was on, so nothing was pressed; `note` says why. */
  guard: "network" | "none";
  /** The requests the guard stopped, each with the element pressed before it (`[]` when none, or no guard). */
  blocked: BlockedRequest[];
  /** Why exploration did less than usual, for a person to read. Fixed words and counts, never what an error said. */
  note?: string;
}

const NOT_PRESSED_NOTE = "no trigger and no wizard step was pressed; only overlays already open were read";
export const NO_GUARD_NOTE = `the browser backend cannot guard the network, so ${NOT_PRESSED_NOTE}`;
const NOTHING_TO_PRESS_NOTE = "no button on the page announces an overlay, so nothing was pressed";

const MAX_TRIGGERS = 8;
/** Nested overlays are followed this deep (page → overlay → nested overlay → one more). */
const MAX_DEPTH = 3;
/** Buttons pressed per overlay to look for a nested one. */
const MAX_NESTED_PROBES = 4;
const MAX_WIZARD_STEPS = 6;
/** What is typed into an empty field to get past a step's validation. Never submitted: only Next is pressed. */
const FILLER = "Cairn test";
/** How long a press may wait for its element: a step button that never becomes clickable is not waited for 30 s. */
const PRESS_TIMEOUT_MS = 3_000;

const DESTRUCTIVE_REASON = "destructive";
const COMPLETION_REASON = "completes the form; not pressed";
const SILENT_REASON = "does not say it opens anything (no aria-haspopup, aria-expanded or aria-controls); not pressed";
const DISABLED_REASON = "disabled; not pressed";
const SUBMITS_FORM_REASON = "submits a form";
const UNREAD_REASON = "could not be read as visible on the page, so what it announces is not known; not pressed";
const NOT_THERE_REASON = "announces a popup on the page, but was not there in the browser that presses (a stopped request can be why); not pressed";
const PRESS_FAILED_REASON = "could not be pressed, or what it opened could not be read to the end";
/** #252: the same words as a click refused for it (#226), with the count. */
const ambiguousReason = (count: number): string =>
  `${count} visible elements with this role and name, and nothing tells them apart (no named row, card or section); not pressed`;

/**
 * #225 review 5: what a failed start of the guard may say of its error: the code or the name, each only in the shape a
 * code or an error's name has. Never its message, which can quote what the session holds, and this goes into the report.
 */
function errorCategory(e: unknown): string {
  const { name, code } = (typeof e === "object" && e !== null ? e : {}) as { name?: unknown; code?: unknown };
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  if (typeof name === "string" && /^([A-Z][A-Za-z0-9]{0,39})?Error$/.test(name)) return name;
  return "unknown error";
}

/**
 * Why `e` may not be pressed while looking for an overlay, or undefined when it may. The deny-list first (destructive,
 * completion, a button that submits its form), then the allow-list: only a control that announces a popup. `popup`
 * and `submitsForm` are what the backend read from it.
 */
export function refusal(
  e: { name?: string; disabled?: true },
  popup: ElementState["popup"] | undefined,
  submitsForm?: boolean,
): string | undefined {
  if (!passesSafetyFilters(e.name)) return DESTRUCTIVE_REASON;
  if (isCompletionName(e.name)) return COMPLETION_REASON;
  if (e.disabled) return DISABLED_REASON;
  if (submitsForm) return SUBMITS_FORM_REASON; // #225 review 2: it would post the form, whatever it announces
  if (!popup || (popup.hasPopup === undefined && popup.expanded === undefined && popup.controls === undefined)) return SILENT_REASON;
  return undefined;
}

/** A step button (Next, Back) of a wizard: pressed only when enabled and passing the destructive-action filters. */
const pressableStep = (e: ElementRef | undefined): e is ElementRef => !!e && !e.disabled && passesSafetyFilters(e.name);

interface Step {
  role: string;
  name?: string;
  scope?: OverlayScope;
}

interface Snap {
  obs: Observation;
  els: ElementRef[];
  stack: OverlayView[];
}

const sameScope = (a?: OverlayScope, b?: OverlayScope): boolean => a?.role === b?.role && a?.name === b?.name;

export async function exploreOverlays(input: ExploreOverlaysInput): Promise<ExploreOverlaysResult> {
  const { gateway, url, study } = input;
  const say = input.onProgress ?? (() => undefined);
  const baseline = study.ariaYaml;
  const states: OverlayState[] = [];
  const skipped: ExploreOverlaysResult["skipped"] = [];
  const toasts: string[] = [];
  const baselineToasts = new Set(toastTexts(baseline));

  const note = (texts: string[]): string[] => {
    const fresh = texts.filter((t) => !baselineToasts.has(t));
    for (const t of fresh) if (!toasts.includes(t)) toasts.push(t);
    return fresh;
  };
  let unread = 0;
  let notThere = 0;
  let pressFailed = 0;
  let replaced = 0;
  const skip = (e: { role: string; name?: string }, reason: string): void => {
    if (!skipped.some((s) => s.role === e.role && s.name === e.name && s.reason === reason)) {
      skipped.push({ role: e.role, ...(e.name !== undefined ? { name: e.name } : {}), reason });
    }
  };

  const read = (obs: Observation): Snap => {
    const nonModal = new Set(obs.nonModal ?? []);
    return {
      obs,
      els: parseAriaSnapshot(obs.ariaSnapshot, { nonModal }),
      stack: overlayStack(obs.ariaSnapshot, { baseline, nonModal }),
    };
  };
  const snap = async (): Promise<Snap> => read(await gateway.observe({}));
  const find = (s: Snap, step: Step): ElementRef | undefined =>
    s.els.find((e) => e.role === step.role && e.name === step.name && sameScope(e.scope, step.scope) && !e.underOverlay);

  /** The page from scratch, then each step of `path` pressed in turn. `before`: the overlays open before the last press. */
  async function replay(path: Step[]): Promise<{ ok: boolean; missing?: true; outcome?: string; before: number; snap: Snap }> {
    let s = read(await gateway.observe({ url }));
    let before = s.stack.length;
    let outcome: string | undefined;
    for (const step of path) {
      const el = find(s, step);
      if (!el) return { ok: false, missing: true, before, snap: s };
      before = s.stack.length;
      const res = await gateway.act({ kind: "click", ref: el.ref, timeoutMs: PRESS_TIMEOUT_MS });
      if (!res.ok) return { ok: false, outcome: res.outcome, before, snap: s };
      outcome = res.outcome;
      s = await snap();
    }
    return { ok: true, outcome, before, snap: s };
  }

  /** #225 review 3: pressing `e` would submit a form — read from the element, never from its name. */
  const submitsForm = async (e: ElementRef): Promise<boolean> => (await gateway.getState(e).catch(() => undefined))?.submitsForm === true;

  const signature = (els: ElementRef[]): string => els.filter((e) => e.interactive || e.role === "heading").map((e) => `${e.role}:${e.name ?? ""}`).join("|");

  /**
   * The steps of a wizard in the overlay `scope`, from the state `s` it is open in. Only Next and Back are pressed,
   * each only when enabled, passing the destructive-action filters and not submitting a form (#225 review 3).
   */
  async function walkWizard(s: Snap, scope: OverlayScope): Promise<WizardInfo | undefined> {
    const inScope = (x: Snap): ElementRef[] => x.els.filter((e) => e.inside && sameScope(e.inside, scope) && !e.underOverlay);
    const first = wizardButtons(inScope(s), scope.role);
    if (!first) return undefined;
    const steps: WizardStep[] = [];
    const sigs: string[] = [];
    let cur = s;
    let back = first.back?.name;
    let backWorks: boolean | undefined;
    for (let i = 0; i < MAX_WIZARD_STEPS; i++) {
      const els = inScope(cur);
      sigs.push(signature(els));
      steps.push({
        index: i,
        headings: els.filter((e) => e.role === "heading" && e.name).map((e) => e.name!),
        fields: els.filter((e) => /^(textbox|combobox|checkbox|radio|switch|searchbox|spinbutton)$/.test(e.role)).map((e) => e.name ?? e.role),
      });
      // #225 review 3: Back is read from the step that shows it — in a two-step wizard only the last one does
      back ??= els.find((e) => e.role === "button" && !e.underOverlay && isBackName(e.name))?.name;
      const wiz = wizardButtons(els, scope.role);
      if (!wiz) break; // the last step has no Next
      if (!passesSafetyFilters(wiz.next.name)) {
        skip(wiz.next, DESTRUCTIVE_REASON);
        break;
      }
      // #225 review 3: a Next that submits its form (a <button> with no type inside <form method=post>) posts it
      if (!wiz.next.disabled && (await submitsForm(wiz.next))) {
        skip(wiz.next, SUBMITS_FORM_REASON);
        break;
      }
      const pressed = wiz.next.disabled ? undefined : await gateway.act({ kind: "click", ref: wiz.next.ref, timeoutMs: PRESS_TIMEOUT_MS });
      if (pressed && !pressed.ok) break;
      let next = pressed ? await snap() : cur;
      if (signature(inScope(next)) === sigs[i]) {
        // Next did not move on (or is disabled until the step is filled): validation. Record what the page said,
        // then try once with the empty fields filled.
        steps[i]!.nextBlocked = note(toastTexts(next.obs.ariaSnapshot).filter((t) => !toastTexts(cur.obs.ariaSnapshot).includes(t)));
        const empties = inScope(next).filter((e) => e.role === "textbox" || e.role === "searchbox");
        for (const f of empties) await gateway.act({ kind: "fill", ref: f.ref, value: FILLER }).catch(() => undefined);
        const retry = wizardButtons(inScope(await snap()), scope.role);
        if (!pressableStep(retry?.next)) break; // still disabled after filling: the steps beyond are not reachable here
        if (await submitsForm(retry.next)) {
          skip(retry.next, SUBMITS_FORM_REASON);
          break;
        }
        await gateway.act({ kind: "click", ref: retry.next.ref, timeoutMs: PRESS_TIMEOUT_MS });
        next = await snap();
        if (signature(inScope(next)) === sigs[i]) break; // still blocked: the steps beyond are not reachable here
      }
      cur = next;
    }
    if (steps.length > 1) {
      // Back from the last step reached must land on the step before it.
      const backEl = inScope(cur).find((e) => e.role === "button" && e.name === back);
      if (pressableStep(backEl) && (await submitsForm(backEl))) skip(backEl, SUBMITS_FORM_REASON);
      else if (pressableStep(backEl) && (await gateway.act({ kind: "click", ref: backEl.ref, timeoutMs: PRESS_TIMEOUT_MS })).ok) {
        backWorks = signature(inScope(await snap())) === sigs[sigs.length - 2];
      }
    }
    return { steps, next: first.next.name ?? "Next", ...(back ? { back } : {}), ...(backWorks !== undefined ? { backWorks } : {}) };
  }

  /** One overlay that `path` opened (`before` overlays were open already). Recurses into the overlays it opens. */
  async function inspect(path: Step[], opened: { snap: Snap; before: number }, parent: OverlayState | undefined, depth: number): Promise<void> {
    const { snap: s, before } = opened;
    if (s.stack.length <= before) return; // nothing new came up
    const top = s.stack[s.stack.length - 1]!;
    const scope: OverlayScope = { role: top.role, ...(top.name !== undefined ? { name: top.name } : {}) };
    const last = path[path.length - 1]!;
    const state: OverlayState = {
      id: `overlay-${states.length + 1}`,
      kind: top.kind,
      role: top.role,
      ...(top.name !== undefined ? { name: top.name } : {}),
      modal: top.modal,
      ...(parent ? { parent: parent.id } : {}),
      trigger: { role: last.role, ...(last.name !== undefined ? { name: last.name } : {}), ...(last.scope ? { scope: last.scope } : {}) },
      exits: overlayExits(top),
      elements: overlayElements(top.elements),
      toasts: note(toastTexts(s.obs.ariaSnapshot)),
      skipped: [],
    };
    states.push(state);
    say(`exploreOverlays — ${state.kind}${state.name ? ` "${state.name}"` : ""} opened by "${last.name ?? last.role}"`);
    for (const x of state.exits) if (x.kind === "submit" && x.safe === false) skip({ role: "button", name: x.name }, DESTRUCTIVE_REASON);

    // The wizard first: it needs the overlay as it was opened.
    const wizard = await walkWizard(s, scope);
    if (wizard) {
      state.wizard = wizard;
      state.toasts = [...new Set([...state.toasts, ...wizard.steps.flatMap((w) => w.nextBlocked ?? [])])];
    }

    // Nested overlays: press what is neither an exit, a step nor a completion, and see whether another one opens.
    if (depth < MAX_DEPTH) {
      const reopen = wizard ? await replay(path) : { ok: true, snap: s, before, outcome: undefined };
      const here = reopen.ok ? reopen.snap : undefined;
      const exitNames = new Set(state.exits.map((x) => x.name));
      const probes = top.elements.filter((e) => e.role === "button" && e.name && !exitNames.has(e.name) && !(state.wizard && isStepName(e.name)));
      // Read what each button announces while the overlay is open as `here` shows it; then press only the ones allowed.
      const reasons = new Map<ElementRef, string | undefined>();
      if (here) {
        for (const b of probes) {
          const fresh = here.els.find((e) => e.role === b.role && e.name === b.name && sameScope(e.inside, scope) && !e.underOverlay) ?? b;
          reasons.set(b, await refusalOf(fresh));
        }
      }
      let probed = 0;
      for (const b of probes) {
        if (!here) break;
        const reason = reasons.get(b);
        if (reason) {
          skip(b, reason);
          state.skipped.push({ role: b.role, name: b.name, reason });
          continue;
        }
        if (probed++ >= MAX_NESTED_PROBES) break;
        const step: Step = { role: b.role, name: b.name, ...(b.scope ? { scope: b.scope } : {}) };
        const re = await replay([...path, step]);
        if (re.ok && re.snap.stack.length > re.before) await inspect([...path, step], { snap: re.snap, before: re.before }, state, depth + 1);
      }
    }

    // Exits that can only be probed: a click outside, then Escape. Each one that closes it is verified.
    const probeExit = async (kind: "click-outside" | "escape"): Promise<void> => {
      const re = await replay(path);
      if (!re.ok) return;
      const res = await gateway.act(kind === "escape" ? { kind: "press", key: "Escape" } : { kind: "click-outside", scope });
      if (!res.ok) {
        // A click outside is made only at a point checked to be safe; with none, it is recorded as not tried.
        if (kind === "click-outside") pushExit(state.exits, { kind, notTried: res.error ?? "not tried" });
        return;
      }
      const after = await snap();
      const closed = after.stack.length <= re.before;
      pushExit(state.exits, { kind, verified: closed });
    };
    await probeExit("click-outside");
    await probeExit("escape");
    state.exits.sort((a, b) => EXIT_ORDER.indexOf(a.kind) - EXIT_ORDER.indexOf(b.kind));
  }

  // ── what may be pressed (#225 review 5) ────────────────────────────────────
  // Only a button that says it opens something is pressed (allow-list). Read on the crawler's own page, before anything
  // starts: reading presses nothing, and it is the page the study describes. Where the presses happen, a request the app
  // reads through may be stopped and the button not be there at all.
  if (!gateway.guardWrites) return readOpenOverlays(NO_GUARD_NOTE);
  const found: ElementRef[] = [];
  for (const e of study.elements.filter((e) => e.role === "button" && e.interactive && !e.underOverlay && !e.scope && !e.inside)) {
    if (found.some((c) => c.name === e.name)) continue;
    const reason = await refusalOf(e);
    if (reason) skip(e, reason);
    else found.push(e);
  }
  if (found.length === 0) {
    // no second browser for nothing to press
    const why = unread > 0 ? `${troubles()}, so nothing was pressed` : NOTHING_TO_PRESS_NOTE;
    say(`exploreOverlays — ${why}`);
    return { states, skipped, toasts, guard: "none", blocked: [], note: why };
  }
  const limit = input.maxTriggers ?? MAX_TRIGGERS;
  for (const c of found.slice(limit)) skip(c, `over the limit of ${limit} triggers`);
  const triggers = found.slice(0, limit);

  // ── the write guard (#225 reviews 3, 4) ────────────────────────────────────
  // On before the first press; everything below happens in its throwaway browser, which goes away after the last press,
  // also on an error. The crawler's own page never saw any of it. Without a guard nothing is pressed at all.
  let guard: WriteGuard | undefined;
  try {
    guard = await gateway.guardWrites();
  } catch (e) {
    const failed = `the write guard did not start (${errorCategory(e)})`;
    for (const c of triggers) skip(c, `${failed}; not pressed`);
    return readOpenOverlays(`${failed}, so ${NOT_PRESSED_NOTE}`);
  }
  if (!guard) {
    for (const c of triggers) skip(c, "no write guard; not pressed");
    return readOpenOverlays(NO_GUARD_NOTE);
  }
  let blocked: BlockedRequest[] = [];
  try {
    await pressTriggers();
  } finally {
    // #252: read before the release: that browser is gone after it. Said, not undone: carrying the new cookie back to
    // the crawler would break "nothing flows back", and whether the site ended the old session is not known here.
    replaced = (await guard.sessionReplaced?.().catch(() => 0)) ?? 0;
    blocked = await guard.release().catch(() => []);
  }
  for (const b of blocked) say(`exploreOverlays — stopped ${b.method} ${b.path}${b.pressed ? ` after "${b.pressed.name ?? b.pressed.role}"` : ""}`);
  say(`exploreOverlays — ${states.length} overlay state(s) from ${triggers.length} triggers`);
  const trouble = troubles();
  if (trouble) say(`exploreOverlays — ${trouble}`);
  return { states, skipped, toasts, guard: "network", blocked, ...(trouble ? { note: trouble } : {}) };

  /** Why `e` may not be pressed, or undefined when it may. A button its name or its study refuses is not read at all. */
  async function refusalOf(e: ElementRef): Promise<string | undefined> {
    if (!passesSafetyFilters(e.name) || isCompletionName(e.name) || e.disabled) return refusal(e, undefined);
    const state = await gateway.getState(e).catch(() => undefined);
    // #252: visible, and several like it: it is not pressed for that, not for being unread
    if (state?.ambiguous !== undefined) return ambiguousReason(state.ambiguous);
    if (!state?.visible) {
      unread++;
      return UNREAD_REASON; // what it announces is not known, which is not the same as announcing nothing
    }
    return refusal(e, state.popup, state.submitsForm);
  }

  /** What did not go as usual, for a person to read: fixed words and counts, nothing a page or an error said. */
  function troubles(): string {
    return [
      unread > 0 ? `${unread} button(s) could not be read` : "",
      notThere > 0 ? `${notThere} trigger(s) announced on the page were not there in the browser that presses` : "",
      pressFailed > 0 ? `${pressFailed} trigger(s) could not be pressed, or what they opened could not be read to the end` : "",
      replaced > 0
        ? `the site replaced ${replaced} session cookie(s) while the pressing browser read its pages, and the crawler still holds the old ones: on a site that ends a replaced session, the rest of this run is signed out`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  /** Nothing is pressed: only the overlays open when the page was read are recorded, and the result says why. */
  function readOpenOverlays(why: string): ExploreOverlaysResult {
    for (const top of overlayStack(baseline)) {
      states.push({
        id: `overlay-${states.length + 1}`,
        kind: top.kind,
        role: top.role,
        ...(top.name !== undefined ? { name: top.name } : {}),
        modal: top.modal,
        trigger: { role: "page" }, // open when the page was read: nothing opened it
        exits: overlayExits(top),
        elements: overlayElements(top.elements),
        toasts: [],
        skipped: [],
      });
    }
    say(`exploreOverlays — ${why}`);
    return { states, skipped, toasts, guard: "none", blocked: [], note: why };
  }

  /** The page's own triggers, pressed while the write guard is on. */
  async function pressTriggers(): Promise<void> {
    say(`exploreOverlays — pressing ${triggers.length} trigger(s) with the write guard on`);
    for (const c of triggers) {
      try {
        const step: Step = { role: c.role, name: c.name };
        const re = await replay([step]);
        if (re.missing) {
          notThere++;
          skip(c, NOT_THERE_REASON);
        } else if (!re.ok) {
          pressFailed++;
          skip(c, PRESS_FAILED_REASON);
        } else if (re.snap.stack.length > re.before) {
          await inspect([step], { snap: re.snap, before: re.before }, undefined, 0);
        } // else it opened nothing: not a trigger
      } catch {
        // one trigger that fails to open must not end the exploration of the others
        pressFailed++;
        skip(c, PRESS_FAILED_REASON);
      }
    }
  }
}

function pushExit(exits: OverlayExit[], x: OverlayExit): void {
  const i = exits.findIndex((e) => e.kind === x.kind);
  if (i >= 0) exits[i] = x;
  else exits.push(x);
}

export const PurposesSchema = z.object({ overlays: z.array(z.object({ id: z.string(), purpose: z.string() })).default([]) });

/**
 * Gives each overlay a short purpose («create a project») for cases and docs. The only LLM call about overlays, and
 * it never decides what is one. Best effort: a failure leaves the states as they are.
 */
export async function nameOverlays(
  states: OverlayState[],
  ctx: { pageSemantics: string; language?: string },
  deps: { invoke: StructuredInvoke; prompts: PromptRegistry },
): Promise<OverlayState[]> {
  if (states.length === 0) return states;
  try {
    const prompt = await deps.prompts.getPrompt("name-overlays", {
      pageSemantics: ctx.pageSemantics,
      overlays: formatOverlays(states),
      language: ctx.language ?? "English",
    });
    const raw = await deps.invoke(PurposesSchema, [new HumanMessage(prompt.text)]);
    const byId = new Map(raw.overlays.map((o) => [o.id, o.purpose.trim().slice(0, 80)]));
    return states.map((s) => (byId.get(s.id) ? { ...s, purpose: byId.get(s.id)! } : s));
  } catch {
    return states;
  }
}
