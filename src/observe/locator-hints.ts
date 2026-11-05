import type { ElementRef, VerifiedElement } from "../browser/types.js";
import { scopedLocator } from "./overlays.js";

/**
 * #226: how a repeated element is described to the design and codegen prompts. Never as «take the first»: a narrowed
 * element gets the locator that goes through its row, card or section; one nothing tells apart is marked so that it is
 * not clicked; one whose narrowing is not known (the cli backend verifies nothing in context) is told to narrow.
 */
export function repeatedHint(e: VerifiedElement): string {
  if (e.count <= 1 && !e.ambiguous) return "";
  const n = e.count > 1 ? `×${e.count} — ` : "";
  if (e.ambiguous) {
    return ` (${n}ambiguous: nothing tells these apart — no named row, card or section — so do not click it; at most assert it is visible)`;
  }
  if (e.narrowedBy) return ` (${n}repeated; reach it through its ${e.narrowedBy.role}: ${scopedLocator(e.scope, e.role, e.name, e.narrowedBy)})`;
  return ` (${n}repeated; narrow by the accessible name of its row, card or section; .first() / .nth() only with a comment saying why the position is the point of the check)`;
}

/** The Playwright source of an element's locator: inside its dialog, through its row when that is what tells it apart. */
export function elementLocator(e: ElementRef & { narrowedBy?: VerifiedElement["narrowedBy"] }): string {
  return scopedLocator(e.scope, e.role, e.name, e.narrowedBy);
}
