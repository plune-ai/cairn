/**
 * #231 — `cairn check-docs`: do the docs still match the UI?
 *
 * Everything here is pure. The docs are read in the format `cairn collect-docs` writes (`docs.ts`, described in
 * docs/collect-docs.md), and so is the UI: a fresh walk is rendered to that format and read back with the same reader,
 * so the two sides are compared line for line, never through two parsers that could drift. Only facts are compared —
 * screens, overlays, fields, the controls a user can press and where they lead. The model's words ("What it is", "User
 * might") and the Questions are a person's to edit and are not compared.
 */
import { DOCS_FILE } from "./docs.js";

/** What the report says when nothing differs. */
export const MATCH_LINE = "The docs match the UI.";
/** The exit code of a run that found a mismatch (a run that could not walk or read exits 1). */
export const DOCS_MISMATCH_EXIT_CODE = 2;

export interface DocItem {
  /** `field` or `control`. */
  type: "field" | "control";
  role: string;
  /** "" for an unnamed control. */
  name: string;
  /** A control that says where it leads: the section ref (`Screen "Settings"`). */
  target?: string;
}

/** One section of a docs file, as far as it is compared. */
export interface ReadSection {
  kind: string;
  title: string;
  /** The heading's anchor in the docs file (GitHub-style), for links from the report. */
  anchor: string;
  address?: string;
  /** Overlays: the "Opened from" entries. */
  openedFrom: string[];
  screenshot?: string;
  items: DocItem[];
}

const ref = (s: Pick<ReadSection, "kind" | "title">): string => `${s.kind} "${s.title}"`;

/** A GitHub-style heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const NAME = String.raw`(?:"(.*)"|\(unnamed ([a-z]+)\))`;
const CONTROL_LINES: { re: RegExp; role?: string }[] = [
  { re: new RegExp(String.raw`^Go to (.+?) — link ${NAME}$`), role: "link" },
  { re: new RegExp(String.raw`^Open (.+?) — button ${NAME}$`), role: "button" },
  { re: new RegExp(String.raw`^Follow the link ${NAME}(?: \(.*\))?$`), role: "link" },
  { re: new RegExp(String.raw`^Press ${NAME}$`), role: "button" },
  { re: new RegExp(String.raw`^Switch to the tab ${NAME}$`), role: "tab" },
  { re: new RegExp(String.raw`^Choose ${NAME}$`), role: "menuitem" },
  { re: new RegExp(String.raw`^Pick ${NAME}$`), role: "option" },
  { re: new RegExp(String.raw`^Use the ([a-z]+) ${NAME}$`) },
];

/** A "User can" line as a control, or undefined for a line in another form (free text a person wrote). */
export function controlOf(line: string): DocItem | undefined {
  for (const { re, role } of CONTROL_LINES) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const g = m.slice(1);
    // the groups: [target?] name unnamedRole — or, for "Use the", role name unnamedRole
    if (!role) return { type: "control", role: g[0]!, name: g[1] ?? "" };
    const hasTarget = g.length === 3;
    return { type: "control", role, name: (hasTarget ? g[1] : g[0]) ?? "", ...(hasTarget ? { target: g[0]! } : {}) };
  }
  return undefined;
}

/**
 * The sections of a docs file in the collect-docs format: `## <Kind>: <title>` (all but `## Questions`), with their
 * address, "Opened from", screenshot, fields and "User can" controls. Lines in another form are skipped.
 */
export function parseDocsMd(md: string): ReadSection[] {
  const out: ReadSection[] = [];
  const anchors = new Map<string, number>();
  let cur: ReadSection | undefined;
  let list: "fields" | "can" | undefined;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      list = undefined;
      const m = /^(.+?):\s+(.+)$/.exec(h[1]!);
      if (!m || h[1] === "Questions") {
        cur = undefined;
        continue;
      }
      const base = headingAnchor(h[1]!);
      const n = anchors.get(base) ?? 0;
      anchors.set(base, n + 1);
      cur = { kind: m[1]!, title: m[2]!, anchor: n ? `${base}-${n}` : base, openedFrom: [], items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^\*\*Fields\*\*$/.test(line)) list = "fields";
    else if (/^\*\*User can\*\*$/.test(line)) list = "can";
    else if (/^\*\*.+\*\*$/.test(line)) list = undefined;
    const shot = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(line);
    if (shot && !cur.screenshot) cur.screenshot = shot[1]!;
    const address = /^- Address: `(.*)`$/.exec(line);
    if (address) cur.address = address[1]!;
    const opened = /^- Opened from: (.*)$/.exec(line);
    if (opened) cur.openedFrom = opened[1]!.split("; ").map((s) => s.trim());
    const item = /^- (.*)$/.exec(line)?.[1];
    if (!item || !list) continue;
    if (list === "fields") {
      const f = /^"(.*)" — ([a-z]+)(?:, required)?$/.exec(item);
      if (f) cur.items.push({ type: "field", role: f[2]!, name: f[1]! });
    } else {
      const c = controlOf(item);
      if (c) cur.items.push(c);
    }
  }
  return out;
}

export type MismatchKind = "missing-in-ui" | "missing-in-docs" | "differs";

export interface Mismatch {
  kind: MismatchKind;
  /** The section it is in, as the docs name it (or the UI, for a section the docs do not have). */
  section: string;
  /** The docs section's anchor, when the docs have the section. */
  anchor?: string;
  /** The UI section's screenshot, when the UI has the section. */
  screenshot?: string;
  /** What differs: `field "Due date" (textbox)`, `the section itself`. */
  what: string;
  /** For `differs`: the docs' value, then the UI's. */
  docs?: string;
  ui?: string;
}

const itemLabel = (i: DocItem): string => `${i.type === "field" ? "field" : i.role} ${i.name ? `"${i.name}"` : "(unnamed)"}${i.type === "field" ? ` (${i.role})` : ""}`;
const itemKey = (i: DocItem): string => `${i.type}\u0000${i.role}\u0000${i.name}`;

/**
 * Pairs what is on both sides. Screens by address (else by title), overlays by kind and title. A section left alone on
 * each side with the same address, or the same kind and the same opener, is the same section renamed. Within a pair,
 * fields and controls by role and name; one left alone on each side with the same type and role is the same one
 * renamed. Anything still alone is missing on the other side.
 */
export function compareDocs(docs: ReadSection[], ui: ReadSection[]): Mismatch[] {
  const out: Mismatch[] = [];
  const pairs: [ReadSection, ReadSection][] = [];
  const freeUi = [...ui];
  const take = (pred: (u: ReadSection) => boolean): ReadSection | undefined => {
    const i = freeUi.findIndex(pred);
    return i >= 0 ? freeUi.splice(i, 1)[0] : undefined;
  };
  const freeDocs: ReadSection[] = [];
  for (const d of docs) {
    const u =
      d.kind === "Screen" && d.address !== undefined
        ? take((x) => x.kind === "Screen" && x.address === d.address)
        : take((x) => x.kind === d.kind && x.title === d.title);
    if (u) pairs.push([d, u]);
    else freeDocs.push(d);
  }
  // Renamed: a screen with no address left, by title; an overlay alone on both sides with the same opener.
  for (const d of [...freeDocs]) {
    const u = take((x) => x.kind === d.kind && (x.title === d.title || (d.kind !== "Screen" && d.openedFrom.some((o) => x.openedFrom.includes(o)))));
    if (!u) continue;
    freeDocs.splice(freeDocs.indexOf(d), 1);
    pairs.push([d, u]);
  }

  // How a docs section ref reads in the UI, so a renamed screen does not make every link to it differ too.
  const asUi = new Map(pairs.map(([d, u]) => [ref(d), ref(u)]));
  for (const [d, u] of pairs) {
    const at = { section: ref(d), anchor: d.anchor, ...(u.screenshot ? { screenshot: u.screenshot } : {}) };
    if (d.title !== u.title) out.push({ kind: "differs", ...at, what: `the ${d.kind === "Screen" ? "screen's" : "overlay's"} title`, docs: d.title, ui: u.title });
    const uiLeft = [...u.items];
    const docsLeft: DocItem[] = [];
    for (const di of d.items) {
      const i = uiLeft.findIndex((ui2) => itemKey(ui2) === itemKey(di));
      if (i < 0) {
        docsLeft.push(di);
        continue;
      }
      const [ui2] = uiLeft.splice(i, 1);
      const target = di.target ? (asUi.get(di.target) ?? di.target) : undefined;
      if (target && ui2!.target && target !== ui2!.target) out.push({ kind: "differs", ...at, what: `where ${itemLabel(di)} leads`, docs: di.target!, ui: ui2!.target });
    }
    for (const di of docsLeft) {
      const same = (x: DocItem): boolean => x.type === di.type && x.role === di.role;
      const twin = docsLeft.filter(same).length === 1 && uiLeft.filter(same).length === 1 ? uiLeft.find(same) : undefined;
      if (twin) {
        uiLeft.splice(uiLeft.indexOf(twin), 1);
        out.push({ kind: "differs", ...at, what: `the name of ${di.type === "field" ? `a ${di.role} field` : `a ${di.role}`}`, docs: di.name, ui: twin.name });
      } else out.push({ kind: "missing-in-ui", ...at, what: itemLabel(di) });
    }
    for (const ui2 of uiLeft) out.push({ kind: "missing-in-docs", ...at, what: itemLabel(ui2) });
  }
  for (const d of freeDocs) out.push({ kind: "missing-in-ui", section: ref(d), anchor: d.anchor, what: "the section itself" });
  for (const u of freeUi) out.push({ kind: "missing-in-docs", section: ref(u), ...(u.screenshot ? { screenshot: u.screenshot } : {}), what: "the section itself" });
  return out;
}

// ── API ─────────────────────────────────────────────────────────────────────

/** `GET /projects/{}`: the operations of a spec's endpoints, parameter names left out (`{id}` and `{projectId}` are one). */
export function operationsOf(endpoints: { method: string; path: string }[]): string[] {
  return [...new Set(endpoints.map((e) => `${e.method.toUpperCase()} ${e.path.replace(/\{[^}]*\}/g, "{}")}`))].sort();
}

export interface ApiCheck {
  /** Seen in the traffic, not in the spec: a mismatch. */
  notInSpec: string[];
  /** In the spec, not seen in the traffic: not a mismatch — the walk may simply not have called it. */
  notSeen: string[];
}

/** The spec's operations against those of the draft from the walk's traffic. */
export function compareApi(spec: { method: string; path: string }[], traffic: { method: string; path: string }[]): ApiCheck {
  const s = new Set(operationsOf(spec));
  const d = new Set(operationsOf(traffic));
  return { notInSpec: [...d].filter((o) => !s.has(o)), notSeen: [...s].filter((o) => !d.has(o)) };
}

// ── the report ─────────────────────────────────────────────────────────────

const HEADINGS: Record<MismatchKind, string> = {
  "missing-in-ui": "In the docs, not in the UI",
  "missing-in-docs": "In the UI, not in the docs",
  differs: "Name differs",
};

export interface CheckReport {
  origin: string;
  /** The docs file, as the report links to it (relative to the report). */
  docsLink: string;
  screens: number;
  overlays: number;
  mismatches: Mismatch[];
  api?: ApiCheck;
}

/** Mismatches that fail the run: the UI's, and API operations the spec does not have. */
export const mismatchCount = (r: Pick<CheckReport, "mismatches" | "api">): number => r.mismatches.length + (r.api?.notInSpec.length ?? 0);

/** The report as Markdown: the verdict, then one section per kind of mismatch, each line linking to the docs section and the screen. */
export function renderCheckMd(r: CheckReport): string {
  const n = mismatchCount(r);
  const out = [
    `# Docs check: ${r.origin}`,
    "",
    `Docs: [${r.docsLink}](${r.docsLink}) · the walk saw ${r.screens} screen(s) and ${r.overlays} overlay(s).`,
    "",
    n === 0 ? `**${MATCH_LINE}**` : `**${n} mismatch(es) between the docs and the UI.**`,
  ];
  for (const kind of Object.keys(HEADINGS) as MismatchKind[]) {
    out.push("", `## ${HEADINGS[kind]}`, "");
    const ms = r.mismatches.filter((m) => m.kind === kind);
    if (ms.length === 0) out.push("_None._");
    for (const m of ms) {
      const where = m.anchor ? `[${m.section}](${r.docsLink}#${m.anchor})` : m.section;
      const what = m.kind === "differs" ? `${m.what}: "${m.docs}" in the docs, "${m.ui}" in the UI` : m.what;
      out.push(`- ${where}: ${what}${m.screenshot ? ` — [screen](${m.screenshot})` : ""}`);
    }
  }
  if (r.api) {
    out.push("", "## API: in the traffic, not in the spec", "", ...(r.api.notInSpec.length ? r.api.notInSpec.map((o) => `- \`${o}\``) : ["_None._"]));
    out.push(
      "",
      "## API: in the spec, not seen in the traffic",
      "",
      "Not a mismatch: the walk may not have called them.",
      "",
      ...(r.api.notSeen.length ? r.api.notSeen.map((o) => `- \`${o}\``) : ["_None._"]),
    );
  }
  out.push("");
  return out.join("\n");
}

/** `--docs` names a docs file, or a directory holding one. */
export const docsFileIn = (isDir: boolean, path: string): string => (isDir ? `${path.replace(/[\\/]+$/, "")}/${DOCS_FILE}` : path);
