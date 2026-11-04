import type { ElementRef, OverlayScope } from "../browser/types.js";
import { DESTRUCTIVE } from "../flow/crawl.js";
import { isDeletionIntent } from "../safety/guardrails.js";
import { overlayKey, parseAriaSnapshot } from "./parse-aria.js";

/**
 * #225: overlays as states. Everything here is deterministic and reads the ARIA snapshot only; no LLM and no browser,
 * so it is tested on plain text. The explorer (`agent/overlays.ts`) drives the page and uses these to read it.
 */

export type OverlayKind = "dialog" | "alertdialog" | "drawer" | "menu" | "listbox";

/** One overlay read from one snapshot. */
export interface OverlayView {
  kind: OverlayKind;
  role: string;
  name?: string;
  /** Blocks the page under it: a dialog or alertdialog the DOM does not call non-modal. A menu, a listbox, a drawer does not. */
  modal: boolean;
  /** The interactive elements inside it (refs of the same parse as the page's). */
  elements: ElementRef[];
}

export type ExitKind = "escape" | "close-button" | "cancel" | "click-outside" | "submit";

/** A way out of an overlay (or the way through it: Submit). */
export interface OverlayExit {
  kind: ExitKind;
  name?: string;
  /** Probed: the exit really closed the overlay. Absent when it was not probed (a button is not clicked to find out). */
  verified?: boolean;
  /** Submit only: its name passes the destructive-action filter, so it may be pressed at all. */
  safe?: boolean;
  /** Click outside only: it was not tried, and why (no point outside the overlay was safe to click). */
  notTried?: string;
}

const DRAWER_NAME = /\b(drawer|side\s?(?:bar|panel)|panel|sheet|sidebar)\b/i;
/** Menus, listboxes and side panels are looked for only when they were not on the page to begin with. */
const POPUP_ROLES = new Set(["menu", "listbox", "complementary"]);

/**
 * An exit is the whole name (#225 review): «Close», never «Close account»; «Cancel», never «Cancel subscription». A
 * verb followed by an object acts on that object, and an exit is pressed to leave, so only the bare word counts.
 */
const CLOSE_NAME = /^\s*(?:close|dismiss|×|✕|x|закрити|закрыть)\s*[.!]?\s*$/i;
const CANCEL_NAME = /^\s*(?:cancel|no|not now|never mind|keep editing|скасувати|відміна|ні|отмена)\s*[.!]?\s*$/i;
/**
 * Next of a wizard. «Continue» is not here (#225 review): «Transfer ownership? [Continue]» confirms an action; it is
 * no step.
 */
const NEXT_NAME = /^\s*(?:next|далі|далее)\b/i;
const BACK_NAME = /^\s*(?:back|previous|назад)\b/i;
/** A step indicator: «Step 2 of 3», «Крок 1 з 4», «2 / 3». */
const STEP_INDICATOR = /\b(?:step|крок|шаг)\s*\d+\s*(?:of|\/|з|із|из)\s*\d+\b|^\s*\d+\s*\/\s*\d+\s*$/i;
/** The action that completes an overlay. Broad on purpose: whether it may be pressed is the filter's call, not this name's. */
const SUBMIT_NAME =
  /^(?:save|create|submit|ok|confirm|apply|add|send|update|finish|done|publish|invite|yes|delete|remove|зберегти|створити|підтвердити|додати|готово|видалити|сохранить|создать)\b/i;

/** Next / Back: the steps of a wizard, not ways out of it. */
export const isStepName = (name: string | undefined): boolean => NEXT_NAME.test(name ?? "") || BACK_NAME.test(name ?? "");

/**
 * A name that completes a form or confirms a choice (Save, Submit, OK, Yes…). Exploration never presses one; it also
 * keeps such a button on the page from being taken for something that opens an overlay. «Add», «Create», «Invite»
 * are not here: they open the dialog far more often than they act.
 */
const COMPLETION_NAME = /^(?:save|submit|ok|confirm|apply|send|update|finish|done|publish|yes|зберегти|підтвердити|готово|сохранить)\b/i;
export const isCompletionName = (name: string | undefined): boolean => COMPLETION_NAME.test(name ?? "");

export const EXIT_ORDER: ExitKind[] = ["escape", "close-button", "cancel", "click-outside", "submit"];

/** The Playwright source of a locator: dialog-scoped when the element is inside one (#225). */
export function scopedLocator(scope: OverlayScope | undefined, role: string, name?: string, within?: OverlayScope): string {
  const q = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const by = (r: string, n?: string): string => `getByRole(${q(r)}${n ? `, { name: ${q(n)}, exact: true }` : ""})`;
  // #226: `within` is the row, card or section whose name tells the element apart from the others like it
  return ["page", ...(scope ? [by(scope.role, scope.name)] : []), ...(within ? [by(within.role, within.name)] : []), by(role, name)].join(".");
}

/** The lines of an ARIA snapshot as `role "name"` keys, for "was it there before?". */
function containerKeys(aria: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of parseAriaSnapshot(aria)) {
    if (!POPUP_ROLES.has(e.role)) continue;
    const k = overlayKey(e.role, e.name);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * The overlays of a snapshot, in stack order (document order; a later one lies over an earlier one).
 * `dialog` and `alertdialog` are overlays wherever they are. A `menu`, `listbox` or `complementary` is one only when
 * it was not on the `baseline` page: a sidebar landmark or a plain list box is not a state, one that appeared after
 * an action is. A dialog named like a panel (or a complementary that appeared) is a `drawer`.
 */
export function overlayStack(aria: string, opts: { baseline?: string; nonModal?: ReadonlySet<string> } = {}): OverlayView[] {
  const els = parseAriaSnapshot(aria, opts.nonModal ? { nonModal: opts.nonModal } : {});
  const known = opts.baseline ? containerKeys(opts.baseline) : undefined;
  const seen = new Map<string, number>();
  const out: OverlayView[] = [];
  for (const el of els) {
    const isDialog = el.role === "dialog" || el.role === "alertdialog";
    if (!isDialog && !POPUP_ROLES.has(el.role)) continue;
    if (!isDialog) {
      if (!known) continue;
      const k = overlayKey(el.role, el.name);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n <= (known.get(k) ?? 0)) continue; // on the page before
    }
    const modal = isDialog && !opts.nonModal?.has(overlayKey(el.role, el.name));
    const kind: OverlayKind = isDialog
      ? DRAWER_NAME.test(el.name ?? "") && el.role === "dialog"
        ? "drawer"
        : (el.role as "dialog" | "alertdialog")
      : el.role === "complementary"
        ? "drawer"
        : (el.role as "menu" | "listbox");
    const elements = els.filter(
      (c) => c.interactive && c.inside?.role === el.role && c.inside.name === el.name && insideOf(els, c, el),
    );
    out.push({ kind, role: el.role, ...(el.name !== undefined ? { name: el.name } : {}), modal, elements });
  }
  return out;
}

/** `c` lies after `el` in document order, before the next element that is not inside `el` (same-named containers stay apart). */
function insideOf(els: ElementRef[], c: ElementRef, el: ElementRef): boolean {
  const from = els.indexOf(el);
  const at = els.indexOf(c);
  if (at <= from) return false;
  for (let i = from + 1; i < at; i++) {
    const m = els[i]!;
    if (m.role === el.role && m.name === el.name) return false; // another container of the same name opened in between
  }
  return true;
}

/** The scope of the modal overlay on top, or undefined when none is open — what `observe`, `verify` and `act` look in. */
export function topModalScope(aria: string, nonModal?: ReadonlySet<string>): OverlayScope | undefined {
  const top = overlayStack(aria, nonModal ? { nonModal } : {})
    .filter((o) => o.modal)
    .at(-1);
  return top ? { role: top.role, ...(top.name !== undefined ? { name: top.name } : {}) } : undefined;
}

/** A name that passes both destructive-action filters: pressing it is no deletion, no sign-out. */
export function passesSafetyFilters(name: string | undefined): boolean {
  return !DESTRUCTIVE.test(name ?? "") && !isDeletionIntent(name ?? "");
}

/**
 * The exits of an overlay, read from its buttons: a close button, Cancel (and its kin), and Submit. Esc and a click
 * outside cannot be read from ARIA; the explorer probes them and adds them, verified. `safe` says whether a Submit
 * passes the destructive-action filters (`src/flow/crawl.ts`, `src/safety/guardrails.ts`).
 */
export function overlayExits(view: OverlayView): OverlayExit[] {
  const out: OverlayExit[] = [];
  for (const b of view.elements) {
    if (b.role !== "button" && b.role !== "menuitem") continue;
    const name = b.name ?? "";
    if (isStepName(name)) continue; // steps of a wizard, not exits
    if (CLOSE_NAME.test(name) && !SUBMIT_NAME.test(name)) out.push({ kind: "close-button", name });
    else if (CANCEL_NAME.test(name)) out.push({ kind: "cancel", name });
    else if (SUBMIT_NAME.test(name)) out.push({ kind: "submit", name, safe: passesSafetyFilters(name) });
  }
  return out.sort((a, b) => EXIT_ORDER.indexOf(a.kind) - EXIT_ORDER.indexOf(b.kind));
}

/**
 * The Next and Back buttons among `elements` (the inside of an overlay whose role is `overlayRole`), or undefined when
 * it is not a wizard. A wizard has a Next AND either a Back or a step indicator (#225 review): a Next alone is a form
 * or a confirmation. An `alertdialog` asks to confirm something and is never a wizard.
 */
export function wizardButtons(elements: ElementRef[], overlayRole?: string): { next: ElementRef; back?: ElementRef } | undefined {
  if (overlayRole === "alertdialog") return undefined;
  const buttons = elements.filter((e) => e.role === "button" && !e.underOverlay);
  const next = buttons.find((b) => NEXT_NAME.test(b.name ?? ""));
  if (!next) return undefined;
  const back = buttons.find((b) => BACK_NAME.test(b.name ?? ""));
  const indicator = elements.some((e) => e.role === "progressbar" || STEP_INDICATOR.test(e.name ?? ""));
  if (!back && !indicator) return undefined;
  return { next, ...(back ? { back } : {}) };
}

/** Texts of `status` and `alert` elements (toasts, validation messages): recorded, never states. */
export function toastTexts(aria: string): string[] {
  const lines = aria.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)- (?:status|alert)(?: "[^"]*")?(?:\s*\[[^\]]*\])*:?\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    const inline = (m[2] ?? "").replace(/^"|"$/g, "").trim();
    if (inline) out.push(inline);
    for (let j = i + 1; j < lines.length; j++) {
      const child = lines[j]!;
      const ci = child.length - child.trimStart().length;
      if (child.trim() && ci <= indent) break;
      const t = /^\s*- text:\s*(.*)$/.exec(child)?.[1]?.replace(/^"|"$/g, "").trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** What the explorer records about one overlay or wizard step. */
export interface WizardStep {
  index: number;
  headings: string[];
  fields: string[];
  /** Next did not move on: the messages the page showed (validation). */
  nextBlocked?: string[];
}

export interface WizardInfo {
  steps: WizardStep[];
  next: string;
  back?: string;
  /** Back from the last step reached the step before it. Absent when not probed. */
  backWorks?: boolean;
}

export interface OverlayState {
  id: string;
  kind: OverlayKind | "wizard";
  role: string;
  name?: string;
  modal: boolean;
  /** Which overlay this one opened from (a nested confirmation); absent for one opened from the page. */
  parent?: string;
  /** What opened it. */
  trigger: { role: string; name?: string; scope?: OverlayScope };
  exits: OverlayExit[];
  /** Interactive elements inside, as locators are written for them. */
  elements: { role: string; name?: string; locator: string }[];
  /** Toast and validation texts seen while it was open. */
  toasts: string[];
  wizard?: WizardInfo;
  /** Controls inside that were left alone, and why. */
  skipped: { role: string; name?: string; reason: string }[];
  /** What the overlay is for («create a project») — from the LLM, for cases and docs only; never used to detect. */
  purpose?: string;
}

/** The overlay states as text for the design and codegen prompts. Empty string when there are none. */
export function formatOverlays(states: OverlayState[]): string {
  if (states.length === 0) return "";
  return states
    .map((s) => {
      const head = `- ${s.id} · ${s.kind}${s.name ? ` "${s.name}"` : ""}${s.purpose ? ` — ${s.purpose}` : ""}${s.modal ? " [modal]" : ""}`;
      const lines = [head];
      lines.push(
        `    opened by: ${s.trigger.role}${s.trigger.name ? ` "${s.trigger.name}"` : ""}${s.parent ? ` inside ${s.parent}` : " on the page"}`,
      );
      if (s.exits.length > 0) {
        lines.push(
          `    exits: ${s.exits
            .map((x) => `${x.kind}${x.name ? ` "${x.name}"` : ""}${x.verified === true ? " (verified)" : x.verified === false ? " (does not close it)" : x.notTried ? " (not tried)" : ""}${x.kind === "submit" && x.safe === false ? " (destructive — only check it is visible)" : ""}`)
            .join("; ")}`,
        );
      }
      if (s.elements.length > 0) lines.push(`    elements: ${s.elements.map((e) => `${e.role}${e.name ? ` "${e.name}"` : ""}`).join("; ")}`);
      if (s.toasts.length > 0) lines.push(`    messages seen: ${s.toasts.map((t) => `"${t}"`).join("; ")}`);
      if (s.wizard) {
        lines.push(
          `    wizard: ${s.wizard.steps.length} steps, Next "${s.wizard.next}"${s.wizard.back ? `, Back "${s.wizard.back}"` : ""}${s.wizard.steps
            .filter((st) => st.nextBlocked)
            .map((st) => `; Next is blocked on step ${st.index + 1} by validation (${st.nextBlocked!.join(", ") || "no message"})`)
            .join("")}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}
