import type { ElementRef } from "../browser/types.js";

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

/**
 * Parses the Playwright `ariaSnapshot()` output (YAML-like) into ranked `ElementRef[]`
 * in document order. Skips property lines (`/url`, `/checked`…) and text nodes (`text:`).
 * A pure function — fully testable without a browser.
 */
export function parseAriaSnapshot(aria: string): ElementRef[] {
  const out: ElementRef[] = [];
  let n = 0;

  for (const raw of aria.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line.startsWith("- ")) continue;

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
    out.push({ ref: nativeRef ?? `e${n}`, role, name, interactive, rank: rankFor(role, interactive) });
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
