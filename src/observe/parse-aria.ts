import type { ElementRef, OverlayScope } from "../browser/types.js";

/** Roles the user interacts with (priority for test cases). */
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "switch",
  "slider",
  "searchbox",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "gridcell",
  "treeitem",
]);

/** Semantic containers — low but non-zero priority. */
const LANDMARK = new Set([
  "main",
  "navigation",
  "banner",
  "complementary",
  "contentinfo",
  "region",
  "form",
  "search",
  "article",
  "dialog",
]);

function rankFor(role: string, interactive: boolean): number {
  if (interactive) return 3;
  if (role === "heading") return 2;
  if (LANDMARK.has(role)) return 1;
  return 0;
}

/** #225: roles whose children are scoped to them in a locator. */
const SCOPE_ROLES = new Set(["dialog", "alertdialog"]);
/** #225: roles overlay detection groups elements by. */
const CONTAINER_ROLES = new Set(["dialog", "alertdialog", "menu", "listbox", "complementary"]);

/** #226: containers whose accessible name tells apart the identical elements inside them (the rows of a table, the cards of a list). */
const CONTEXT_ROLES = new Set(["row", "listitem", "article", "group", "region", "form", "treeitem"]);
const MAX_CONTEXT = 3;

export interface ParseOptions {
  /** #225: dialogs (`role|name`) that are NOT modal; every other dialog and alertdialog is taken as modal. */
  nonModal?: ReadonlySet<string>;
}

/** `role|name` — how a dialog is named in {@link ParseOptions.nonModal} and `Observation.nonModal`. */
export const overlayKey = (role: string, name?: string): string => `${role}|${name ?? ""}`;

/**
 * Parses the Playwright `ariaSnapshot()` output (YAML-like) into ranked `ElementRef[]`
 * in document order. Skips property lines (`/url`, `/checked`…) and text nodes (`text:`).
 * A pure function — fully testable without a browser.
 */
export function parseAriaSnapshot(aria: string, opts: ParseOptions = {}): ElementRef[] {
  const out: ElementRef[] = [];
  let n = 0;
  /** #225: the open ancestors of the line being read, by indentation. */
  const open: { indent: number; role: string; name?: string; index: number }[] = [];
  /** #225: for each output element, the output index of every dialog around it (itself last when it is one). */
  const chains: number[][] = [];
  const modals: number[] = [];

  for (const raw of aria.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line.startsWith("- ")) continue;
    const indent = raw.length - line.length;

    const content = unquoteKey(line.slice(2).trim());
    if (content.startsWith("/")) {
      // Property line (/url, /checked, /disabled…). Capture /url onto the preceding element (its link)
      // so crawl can dedup links by (name, href) — #102. Other properties are skipped.
      const last = out[out.length - 1];
      if (content.startsWith("/url") && last) {
        const u = content.slice(4).replace(/^:\s*/, "").replace(/^"|"$/g, "").trim();
        if (u) last.url = u;
      }
      continue;
    }

    const role = content.match(/^([a-zA-Z][\w-]*)/)?.[1];
    if (!role || role === "text") continue; // text node or unparseable

    // #238: the snapshot quotes a name as a JSON string, so `Say "hi"` arrives as `"Say \"hi\""`; read past escaped quotes and unescape.
    const quoted = content.match(/"((?:[^"\\]|\\.)*)"/)?.[1];
    const name = quoted === undefined ? undefined : unescapeName(quoted);
    // A native ref from the cli/MCP snapshot (`[ref=e15]`) takes priority over a synthesized one.
    const nativeRef = content.match(/\[ref=([^\]\s]+)\]/)?.[1];
    const interactive = INTERACTIVE.has(role);
    n += 1;
    while (open.length > 0 && open[open.length - 1]!.indent >= indent) open.pop();
    const scopeOf = (roles: Set<string>): OverlayScope | undefined => {
      const a = [...open].reverse().find((x) => roles.has(x.role));
      return a ? { role: a.role, ...(a.name !== undefined ? { name: a.name } : {}) } : undefined;
    };
    const scope = scopeOf(SCOPE_ROLES);
    const inside = scopeOf(CONTAINER_ROLES);
    const el: ElementRef = { ref: nativeRef ?? `e${n}`, role, name, interactive, rank: rankFor(role, interactive) };
    if (scope) el.scope = scope;
    // #226: stop at the dialog: what is above it is not its context
    const context: OverlayScope[] = [];
    for (const a of [...open].reverse()) {
      if (SCOPE_ROLES.has(a.role)) break;
      if (CONTEXT_ROLES.has(a.role) && a.name) context.push({ role: a.role, name: a.name });
      if (context.length >= MAX_CONTEXT) break;
    }
    if (context.length > 0) el.context = context;
    if (inside) el.inside = inside;
    out.push(el);
    const index = out.length - 1;
    const chain = open.filter((x) => SCOPE_ROLES.has(x.role)).map((x) => x.index);
    if (SCOPE_ROLES.has(role)) {
      chain.push(index);
      if (!opts.nonModal?.has(overlayKey(role, name))) modals.push(index);
    }
    chains.push(chain);
    open.push({ indent, role, name, index });
  }

  // #225: while a modal overlay is open, what is not in its top one lies under it.
  const top = modals[modals.length - 1];
  if (top !== undefined) {
    out.forEach((el, i) => {
      if (!chains[i]!.includes(top)) el.underOverlay = true;
    });
  }

  return out;
}

/** #238: Playwright single-quotes a whole key YAML would misread (a name with `: `, ` #`, `{`): `'button "a: b"':` → `button "a: b":`. */
function unquoteKey(content: string): string {
  const m = /^'((?:[^']|'')*)'(.*)$/.exec(content);
  return m ? (m[1] ?? "").replace(/''/g, "'") + (m[2] ?? "") : content;
}

function unescapeName(quoted: string): string {
  try {
    return JSON.parse(`"${quoted}"`) as string;
  } catch {
    return quoted.replace(/\\(.)/g, "$1");
  }
}
