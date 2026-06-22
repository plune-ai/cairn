import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { styleDirective } from "../checklist/index.js";

export interface ResolveStyleOptions {
  /** Directory of built-in / user style packs (default ./prompts/styles). */
  stylesDir?: string;
}

/**
 * #80 — resolve `--style <value>` into the text for the design prompt's {{style}} slot.
 *
 * Dual behavior, in order:
 *  1. a house-style PACK — `<stylesDir>/<value>.md` (a built-in or user pack), or an explicit
 *     `.md` path — loads that file's text verbatim into the slot;
 *  2. otherwise the built-in inline HINT — `happy` / `negative` / `coverage` (via
 *     {@link styleDirective}); anything else (incl. `all` / unset) → "" (balanced).
 *
 * Style only fills the {{style}} slot — it never touches the methodology or assertion-safety
 * rules baked into the design prompt.
 */
export async function resolveStyleText(
  value: string | undefined,
  opts: ResolveStyleOptions = {},
): Promise<string> {
  if (!value) return styleDirective("all"); // "" — balanced
  const stylesDir = opts.stylesDir ?? join("prompts", "styles");
  // a named pack first (the common case), then an explicit path the user passed directly.
  const candidates = [join(stylesDir, `${value}.md`), value];
  for (const p of candidates) {
    try {
      const text = await readFile(p, "utf8");
      if (text.trim()) return text;
    } catch {
      // not a readable file → try the next candidate
    }
  }
  return styleDirective(value); // inline-hint fallback (happy/negative/coverage), else ""
}
