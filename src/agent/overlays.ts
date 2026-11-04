import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { StructuredInvoke } from "../llm/structured.js";
import type { PromptRegistry } from "../prompts/index.js";
import type { BrowserGateway } from "../browser/gateway.js";
import type { ElementRef, Observation, OverlayScope } from "../browser/types.js";
import type { PageStudy } from "../observe/index.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import {
  EXIT_ORDER,
  formatOverlays,
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
 * no LLM here. Nothing is submitted: a completion button (Save, Submit…) and anything the destructive-action filters
 * refuse are recorded and left alone.
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
}

const MAX_TRIGGERS = 8;
/** Nested overlays are followed this deep (page → overlay → nested overlay → one more). */
const MAX_DEPTH = 3;
/** Buttons pressed per overlay to look for a nested one. */
const MAX_NESTED_PROBES = 4;
const MAX_WIZARD_STEPS = 6;
/** What is typed into an empty field to get past a step's validation. Never submitted: only Next is pressed. */
const FILLER = "Cairn test";

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
      const res = await gateway.act({ kind: "click", ref: el.ref });
      if (!res.ok) return { ok: false, outcome: res.outcome, before, snap: s };
      outcome = res.outcome;
      s = await snap();
    }
    return { ok: true, outcome, before, snap: s };
  }

  const signature = (els: ElementRef[]): string => els.filter((e) => e.interactive || e.role === "heading").map((e) => `${e.role}:${e.name ?? ""}`).join("|");

  /** The steps of a wizard in the overlay `top`, from the state `s` it is open in. Only Next and Back are pressed. */
  async function walkWizard(s: Snap, scope: OverlayScope): Promise<WizardInfo | undefined> {
    const inScope = (x: Snap): ElementRef[] => x.els.filter((e) => e.inside && sameScope(e.inside, scope) && !e.underOverlay);
    const first = wizardButtons(inScope(s));
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
      const wiz = wizardButtons(els);
      if (!wiz) break; // the last step has no Next
      back ??= wiz.back?.name;
      const pressed = await gateway.act({ kind: "click", ref: wiz.next.ref });
      if (!pressed.ok) break;
      let next = await snap();
      if (signature(inScope(next)) === sigs[i]) {
        // Next did not move on: validation. Record what the page said, then try once with the empty fields filled.
        steps[i]!.nextBlocked = note(toastTexts(next.obs.ariaSnapshot).filter((t) => !toastTexts(cur.obs.ariaSnapshot).includes(t)));
        const empties = inScope(next).filter((e) => e.role === "textbox" || e.role === "searchbox");
        for (const f of empties) await gateway.act({ kind: "fill", ref: f.ref, value: FILLER }).catch(() => undefined);
        const retry = wizardButtons(inScope(await snap()));
        if (!retry) break;
        await gateway.act({ kind: "click", ref: retry.next.ref });
        next = await snap();
        if (signature(inScope(next)) === sigs[i]) break; // still blocked: the steps beyond are not reachable here
      }
      cur = next;
    }
    if (steps.length > 1) {
      // Back from the last step reached must land on the step before it.
      const backEl = inScope(cur).find((e) => e.role === "button" && e.name === back);
      if (backEl && (await gateway.act({ kind: "click", ref: backEl.ref })).ok) {
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
    for (const x of state.exits) if (x.kind === "submit" && x.safe === false) skip({ role: "button", name: x.name }, "destructive");

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
      const probes = top.elements.filter((e) => e.role === "button" && e.name && !exitNames.has(e.name) && !isStepName(e.name));
      let probed = 0;
      for (const b of probes) {
        if (!here) break;
        if (!passesSafetyFilters(b.name)) {
          skip(b, "destructive");
          state.skipped.push({ role: b.role, name: b.name, reason: "destructive" });
          continue;
        }
        if (isCompletionName(b.name)) {
          skip(b, "completes the form; not pressed");
          state.skipped.push({ role: b.role, name: b.name, reason: "completes the form; not pressed" });
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
      const res = await gateway.act(kind === "escape" ? { kind: "press", key: "Escape" } : { kind: "click-outside" });
      if (!res.ok) return;
      const after = await snap();
      const closed = after.stack.length <= re.before;
      pushExit(state.exits, { kind, verified: closed });
    };
    await probeExit("click-outside");
    await probeExit("escape");
    state.exits.sort((a, b) => EXIT_ORDER.indexOf(a.kind) - EXIT_ORDER.indexOf(b.kind));
  }

  // ── the page's own triggers ────────────────────────────────────────────────
  const candidates: ElementRef[] = [];
  for (const e of study.elements) {
    if (e.role !== "button" || !e.interactive || e.underOverlay || e.scope || e.inside) continue;
    if (!passesSafetyFilters(e.name)) skip(e, "destructive");
    else if (isCompletionName(e.name)) skip(e, "completes the form; not pressed");
    else if (!candidates.some((c) => c.name === e.name)) candidates.push(e);
  }
  const maxTriggers = input.maxTriggers ?? MAX_TRIGGERS;
  for (const c of candidates.slice(maxTriggers)) skip(c, `over the limit of ${maxTriggers} triggers`);
  for (const c of candidates.slice(0, maxTriggers)) {
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
  say(`exploreOverlays — ${states.length} overlay state(s) from ${Math.min(candidates.length, maxTriggers)} triggers`);
  return { states, skipped, toasts };
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
