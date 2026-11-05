import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { BrowserGateway } from "../browser/gateway.js";
import type { BlockedRequest, ElementRef, ElementState, Observation, OverlayScope } from "../browser/types.js";
import type { PageStudy } from "../observe/index.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import {
  EXIT_ORDER,
  formatOverlays,
  isBackName,
  isCompletionName,
  isStepName,
  overlayExits,
  overlayStack,
  passesSafetyFilters,
  scopedLocator,
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
 * The invariant (#225 review 3): while overlays are explored, nothing cairn presses can change the server, whatever
 * the button is called. The backend's write guard aborts every request but GET, HEAD and OPTIONS from the first press
 * to the last, and lifts it in `finally`; what it stopped is in the result. A backend that cannot guard the network
 * (cli) presses no trigger and no wizard step: it reads the overlays already open and says so.
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
  /** `network`: the write guard was on for every press. `none`: the backend has none, so nothing was pressed. */
  guard: "network" | "none";
  /** The writes the guard stopped, each with the element pressed before it (`[]` when none, or no guard). */
  blocked: BlockedRequest[];
  /** Why exploration did less than usual (no guard), for a person to read. */
  note?: string;
}

export const NO_GUARD_NOTE =
  "the browser backend cannot guard the network, so no trigger and no wizard step was pressed; only overlays already open were read";

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
  async function replay(path: Step[]): Promise<{ ok: boolean; outcome?: string; before: number; snap: Snap }> {
    let s = read(await gateway.observe({ url }));
    let before = s.stack.length;
    let outcome: string | undefined;
    for (const step of path) {
      const el = find(s, step);
      if (!el) return { ok: false, before, snap: s };
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
      elements: top.elements.map((e) => ({
        role: e.role,
        ...(e.name !== undefined ? { name: e.name } : {}),
        locator: scopedLocator(e.scope, e.role, e.name),
      })),
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
          const state = passesSafetyFilters(b.name) && !isCompletionName(b.name) && !fresh.disabled ? await gateway.getState(fresh).catch(() => undefined) : undefined;
          reasons.set(b, refusal(fresh, state?.popup, state?.submitsForm));
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

  // ── the write guard (#225 review 3) ────────────────────────────────────────
  // On before the first press, off after the last, also on an error. Without one nothing is pressed at all.
  const guard = gateway.guardWrites ? await gateway.guardWrites().catch(() => undefined) : undefined;
  if (!guard) {
    for (const top of overlayStack(baseline)) {
      states.push({
        id: `overlay-${states.length + 1}`,
        kind: top.kind,
        role: top.role,
        ...(top.name !== undefined ? { name: top.name } : {}),
        modal: top.modal,
        trigger: { role: "page" }, // open when the page was read: nothing opened it
        exits: overlayExits(top),
        elements: top.elements.map((e) => ({ role: e.role, ...(e.name !== undefined ? { name: e.name } : {}), locator: scopedLocator(e.scope, e.role, e.name) })),
        toasts: [],
        skipped: [],
      });
    }
    say(`exploreOverlays — ${NO_GUARD_NOTE}`);
    return { states, skipped, toasts, guard: "none", blocked: [], note: NO_GUARD_NOTE };
  }
  let blocked: BlockedRequest[] = [];
  let candidates: ElementRef[] = [];
  let maxTriggers = input.maxTriggers ?? MAX_TRIGGERS;
  try {
    ({ candidates, maxTriggers } = await pressTriggers());
  } finally {
    blocked = await guard.release().catch(() => []);
  }
  for (const b of blocked) say(`exploreOverlays — stopped ${b.method} ${b.path}${b.pressed ? ` after "${b.pressed.name ?? b.pressed.role}"` : ""}`);
  say(`exploreOverlays — ${states.length} overlay state(s) from ${Math.min(candidates.length, maxTriggers)} triggers`);
  return { states, skipped, toasts, guard: "network", blocked };

  /** The page's own triggers, pressed while the write guard is on. */
  async function pressTriggers(): Promise<{ candidates: ElementRef[]; maxTriggers: number }> {
    // Only a button that says it opens something is pressed (allow-list), read on the page as it is with nothing open.
    const found: ElementRef[] = [];
    const pageButtons = study.elements.filter((e) => e.role === "button" && e.interactive && !e.underOverlay && !e.scope && !e.inside);
    if (pageButtons.length > 0) await gateway.observe({ url }).catch(() => undefined);
    for (const e of pageButtons) {
      if (found.some((c) => c.name === e.name)) continue;
      const vetted = passesSafetyFilters(e.name) && !isCompletionName(e.name) && !e.disabled;
      const state = vetted ? await gateway.getState(e).catch(() => undefined) : undefined;
      const reason = refusal(e, state?.popup, state?.submitsForm);
      if (reason) skip(e, reason);
      else found.push(e);
    }
    const limit = input.maxTriggers ?? MAX_TRIGGERS;
    for (const c of found.slice(limit)) skip(c, `over the limit of ${limit} triggers`);
    for (const c of found.slice(0, limit)) {
      try {
        const step: Step = { role: c.role, name: c.name };
        const re = await replay([step]);
        if (!re.ok || re.snap.stack.length <= re.before) continue; // it opened nothing: not a trigger
        await inspect([step], { snap: re.snap, before: re.before }, undefined, 0);
      } catch {
        // one trigger that fails to open must not end the exploration of the others
      }
    }
    await gateway.observe({ url }).catch(() => undefined); // leave the page as it was found
    return { candidates: found, maxTriggers: limit };
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
