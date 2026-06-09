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

/**
 * Stage B grounding: for safe (reversible) elements, perform a click, OBSERVE the state transition,
 * and revert it. Does NOT touch buttons (submit/delete), links (navigation), or file inputs.
 * Gives the designer real transitions instead of guessed ones → grounds state-transition assertions.
 */
export async function probeTransitions(
  gateway: BrowserGateway,
  elements: ElementRef[],
): Promise<Transition[]> {
  const out: Transition[] = [];
  for (const el of elements) {
    if (!SAFE_ROLES.has(el.role)) continue;
    const before = await gateway.getState(el);
    if (!before.visible || !before.enabled) continue; // don't touch hidden/disabled

    const clicked = await gateway.act({ kind: "click", ref: el.ref });
    if (!clicked.ok) continue;
    const after = await gateway.getState(el);
    await gateway.act({ kind: "click", ref: el.ref }).catch(() => undefined); // revert (reversibility)

    out.push({ ref: el.ref, role: el.role, name: el.name, before, after });
  }
  return out;
}
