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

/**
 * What keeps a locator on one visible element, beyond what `repeatedHint` says of repeats: a name that is part of
 * another element's name matches both unless it is `exact: true` («Menu» also finds «Select Menu»), and an element
 * outside the page cannot be clicked at all.
 */
export function uniquenessHint(e: VerifiedElement, all: readonly VerifiedElement[]): string {
  if (e.offViewport) return " (outside the viewport, where no scrolling reaches: do not click it; at most assert it exists)";
  const name = e.name?.trim().toLowerCase();
  if (!name) return "";
  const longer = all.find((o) => o !== e && o.role === e.role && o.name && o.name.length > name.length && o.name.toLowerCase().includes(name));
  return longer ? ` (its name is part of "${longer.name}": locate it with { name: '${e.name}', exact: true })` : "";
}

/** The Playwright source of an element's locator: inside its dialog, through its row when that is what tells it apart. */
export function elementLocator(e: ElementRef & { narrowedBy?: VerifiedElement["narrowedBy"] }): string {
  return scopedLocator(e.scope, e.role, e.name, e.narrowedBy);
}
