/**
 * #24 — `cairn collect-docs`: the user docs of an app, from what a walk of its UI saw.
 *
 * Everything here is pure (no browser, no LLM): the description an LLM gives a screen and its cache, the facts read
 * from the ARIA snapshot (fields, what a user can press and where it leads), the questions nobody may guess at, and the
 * Markdown the walk writes. The walk itself is `agent/collect-docs.ts`.
 *
 * The description of a screen is cached like the page understanding (ADR-0018): keyed by URL plus a fingerprint of
 * what the walk saw there (its ARIA snapshot and its overlays), so a second walk of an unchanged screen makes no LLM call.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cacheFile } from "./index.js";
import { isStepName, type OverlayState } from "../observe/overlays.js";

/** The Markdown the walk writes, and the folder its screenshots go to, both in the run's directory. */
export const DOCS_FILE = "docs.md";
export const SCREENSHOTS_DIR = "screenshots";

/** What the LLM says of one screen and its overlays. Strict (no optional key): see `llm/schema-lint.ts`. */
export const ScreenDescriptionSchema = z.object({
  /** What the screen is for, in one sentence; "" when what was seen does not tell. */
  purpose: z.string(),
  /** Tasks a user might come here for. */
  userMight: z.array(z.string()),
  overlays: z.array(z.object({ id: z.string(), purpose: z.string(), userMight: z.array(z.string()) })),
  /** What a new user could not understand from the screen alone, as questions. Never answered by the model. */
  questions: z.array(z.string()),
});
export type ScreenDescription = z.infer<typeof ScreenDescriptionSchema>;

export const NO_DESCRIPTION: ScreenDescription = { purpose: "", userMight: [], overlays: [], questions: [] };

/** Bump when the description shape changes → older cached files are a miss. */
const DESCRIPTION_SCHEMA_VERSION = 1;
const CachedDescriptionSchema = z.object({
  schemaVersion: z.number(),
  url: z.string(),
  fingerprint: z.string(),
  description: ScreenDescriptionSchema,
});
const screensDir = (cacheDir: string): string => join(cacheDir, "screens");

/** What a screen's description rests on: its ARIA snapshot and its overlays as found. Same input ⇒ same description. */
export function screenFingerprint(aria: string, overlaysText: string): string {
  return createHash("sha256").update(`${aria}\n\u0000\n${overlaysText}`).digest("hex").slice(0, 16);
}

/** The cached description of `url`, when it was made from the same `fingerprint`; undefined otherwise. */
export async function loadDescription(cacheDir: string, url: string, fingerprint: string): Promise<ScreenDescription | undefined> {
  try {
    const parsed = CachedDescriptionSchema.safeParse(JSON.parse(await readFile(cacheFile(screensDir(cacheDir), url), "utf8")));
    if (!parsed.success) return undefined;
    const c = parsed.data;
    if (c.schemaVersion !== DESCRIPTION_SCHEMA_VERSION || c.url !== url || c.fingerprint !== fingerprint) return undefined;
    return c.description;
  } catch {
    return undefined;
  }
}

/** Best effort, like the page-understanding cache: a write failure never breaks a run. */
export async function saveDescription(cacheDir: string, url: string, fingerprint: string, description: ScreenDescription): Promise<void> {
  try {
    await mkdir(screensDir(cacheDir), { recursive: true });
    const entry = { schemaVersion: DESCRIPTION_SCHEMA_VERSION, url, fingerprint, description };
    await writeFile(cacheFile(screensDir(cacheDir), url), JSON.stringify(entry, null, 2), "utf8");
  } catch {
    // best effort
  }
}

// ── facts ────────────────────────────────────────────────────────────────────

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "spinbutton", "slider"]);
export const isField = (role: string): boolean => FIELD_ROLES.has(role);

export type SectionKind = "Screen" | "Dialog" | "Alert dialog" | "Drawer" | "Menu" | "List" | "Wizard";

export interface DocField {
  name: string;
  role: string;
  required: boolean;
}

/** One section of the docs: a screen, or an overlay (a modal, a drawer, a menu, a wizard). */
export interface DocSection {
  kind: SectionKind;
  title: string;
  /** Relative to the docs file. */
  screenshot?: string;
  /** Screens: the path of the address. */
  address?: string;
  purpose: string;
  /** Screens: who gets here (the start address, or from where). Overlays: what opens it, and where. */
  arrival: string[];
  /** Overlays: the ways out, and what completes it. */
  exits: string[];
  completes: string[];
  fields: DocField[];
  userCan: string[];
  userMight: string[];
  /** Wizards: one line per step. */
  steps: string[];
}

export interface DocsModel {
  /** The app's origin, for the title. */
  origin: string;
  sections: DocSection[];
  /** Each one prefixed with the section it is about. */
  questions: string[];
}

/** How a section is named elsewhere in the docs: `Screen "Projects"`, `Dialog "New project"`. */
export const sectionRef = (s: Pick<DocSection, "kind" | "title">): string => `${s.kind} "${s.title}"`;

export function overlayKind(state: Pick<OverlayState, "kind" | "wizard">): SectionKind {
  if (state.wizard) return "Wizard";
  const kinds: Record<string, SectionKind> = { dialog: "Dialog", alertdialog: "Alert dialog", drawer: "Drawer", menu: "Menu", listbox: "List", wizard: "Wizard" };
  return kinds[state.kind] ?? "Dialog";
}

/** A screen's title: its first level-1 heading, else its first heading, else the path of its address. */
export function screenTitle(aria: string, url: string): string {
  const headings = [...aria.matchAll(/^\s*- heading "((?:[^"\\]|\\.)*)"(.*)$/gm)].map((m) => ({ name: m[1]!.replace(/\\"/g, '"'), level1: /\[level=1\]/.test(m[2] ?? "") }));
  const h = headings.find((x) => x.level1) ?? headings[0];
  if (h?.name.trim()) return h.name.trim();
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

interface Control {
  role: string;
  name?: string;
  url?: string;
}

const label = (c: Control): string => (c.name ? `"${c.name}"` : `(unnamed ${c.role})`);

/**
 * What a user can do with these controls, one line each, fields left out (they have their own list). A link to a
 * documented screen and a button that opens a documented overlay say where they lead (`links`, `opens`: control name →
 * section ref). `skip`: names already said elsewhere (the exits of an overlay, the steps of a wizard).
 */
export function userCanOf(controls: Control[], targets: { links?: Map<string, string>; opens?: Map<string, string> }, skip: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (const c of controls) {
    if (isField(c.role) || (c.name !== undefined && skip.has(c.name))) continue;
    const name = c.name ?? "";
    let line: string;
    if (c.role === "link") {
      const to = targets.links?.get(name);
      line = to ? `Go to ${to} — link ${label(c)}` : `Follow the link ${label(c)}${c.url ? ` (${c.url})` : ""}`;
    } else if (c.role === "button") {
      const to = targets.opens?.get(name);
      line = to ? `Open ${to} — button ${label(c)}` : `Press ${label(c)}`;
    } else if (c.role === "tab") line = `Switch to the tab ${label(c)}`;
    else if (c.role.startsWith("menuitem")) line = `Choose ${label(c)}`;
    else if (c.role === "option") line = `Pick ${label(c)}`;
    else line = `Use the ${c.role} ${label(c)}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** The fields among `controls`, with what the DOM said is required (`required`: field names). */
export function fieldsOf(controls: Control[], required: ReadonlySet<string>): DocField[] {
  const out: DocField[] = [];
  for (const c of controls) {
    if (!isField(c.role)) continue;
    const name = c.name ?? `(unnamed ${c.role})`;
    if (!out.some((f) => f.name === name && f.role === c.role)) out.push({ name, role: c.role, required: c.name !== undefined && required.has(c.name) });
  }
  return out;
}

/** The ways out of an overlay and what completes it, as the explorer found them (unverified Escape or click outside left out). */
export function overlayExitsOf(state: Pick<OverlayState, "exits">): { exits: string[]; completes: string[] } {
  const exits: string[] = [];
  const completes: string[] = [];
  for (const x of state.exits) {
    if (x.kind === "escape" && x.verified) exits.push("Escape");
    else if (x.kind === "click-outside" && x.verified) exits.push("a click outside it");
    else if ((x.kind === "close-button" || x.kind === "cancel") && x.name) exits.push(`button "${x.name}"`);
    else if (x.kind === "submit" && x.name) completes.push(`button "${x.name}"${x.safe === false ? " (destructive; not pressed while documenting)" : ""}`);
  }
  return { exits, completes };
}

/** Names an overlay's exits and steps take, so its "User can" does not say them twice. */
export function overlaySaidNames(state: Pick<OverlayState, "exits" | "elements">): Set<string> {
  const names = new Set(state.exits.map((x) => x.name).filter((n): n is string => !!n));
  for (const e of state.elements) if (e.name && isStepName(e.name)) names.add(e.name);
  return names;
}

/** A wizard's steps, one line each: its headings, its fields, and what blocked Next. */
export function wizardStepsOf(state: Pick<OverlayState, "wizard">): string[] {
  const w = state.wizard;
  if (!w) return [];
  const lines = w.steps.map((st) => {
    const head = st.headings.join(" / ") || `Step ${st.index + 1}`;
    const fields = st.fields.length ? ` — fields: ${st.fields.map((f) => `"${f}"`).join(", ")}` : "";
    const blocked = st.nextBlocked ? `; Next is blocked until it is filled${st.nextBlocked.length ? ` (the page says: ${st.nextBlocked.map((t) => `"${t}"`).join(", ")})` : ""}` : "";
    return `${head}${fields}${blocked}`;
  });
  if (w.backWorks && lines.length > 0) lines[lines.length - 1] += `; "${w.back ?? "Back"}" returns to the step before`;
  return lines;
}

/** Abbreviations everyone reads alike; any other one is asked about. */
const COMMON_ABBREVIATIONS = new Set(
  "OK ID URL API FAQ PDF CSV UI UX AM PM USD EUR GBP UAH UTC GMT HTTP HTTPS SMS PIN QR JSON HTML CSS PNG JPG GIF SVG XML TV PC IT AI CEO".split(" "),
);

/**
 * Abbreviations shown on a screen that are not common knowledge: words of 2 to 6 capitals and digits, two capitals at
 * least, outside `/url:` lines. Their meaning is asked, never guessed.
 */
// ponytail: ASCII capitals only, and any capitalised word ("NEW" badge) counts; a glossary option if real apps say too much.
export function abbreviationsIn(aria: string): string[] {
  const text = aria
    .split(/\r?\n/)
    .filter((l) => !/^\s*- \/url:/.test(l))
    .join("\n");
  const out: string[] = [];
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)) {
    const w = m[0];
    if ((w.match(/[A-Z]/g) ?? []).length < 2 || COMMON_ABBREVIATIONS.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

/** The questions of one section: its abbreviations, then the model's own, each once, prefixed with the section. */
export function questionsFor(section: Pick<DocSection, "kind" | "title">, abbreviations: string[], fromModel: string[]): string[] {
  const own = [...abbreviations.map((a) => `What does "${a}" mean?`), ...fromModel.map((q) => q.trim()).filter(Boolean)];
  return [...new Set(own)].map((q) => `${sectionRef(section)}: ${q}`);
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const list = (items: string[]): string[] => (items.length ? items.map((i) => `- ${oneLine(i)}`) : ["_None._"]);

/**
 * The docs as Markdown. The format is fixed so a person can edit it and `check-docs` can read it back:
 * one `## <Kind>: <title>` section per screen and overlay, in walk order, with the same lines in the same order, and a
 * last `## Questions` section. See docs/collect-docs.md.
 */
export function renderDocsMd(model: DocsModel): string {
  const screens = model.sections.filter((s) => s.kind === "Screen").length;
  const overlays = model.sections.length - screens;
  const out: string[] = [
    `# Docs: ${model.origin}`,
    "",
    `Written by \`cairn collect-docs\` from what a walk of the app saw: ${screens} screen(s), ${overlays} overlay(s), ${model.questions.length} question(s). ` +
      "Edit freely: each section is one screen or overlay. Anything the walk could not explain is under Questions, not guessed at.",
  ];
  for (const s of model.sections) {
    out.push("", `## ${s.kind}: ${oneLine(s.title)}`, "");
    if (s.screenshot) out.push(`![${s.kind}: ${oneLine(s.title)}](${s.screenshot})`, "");
    if (s.address !== undefined) out.push(`- Address: \`${s.address}\``);
    out.push(`- What it is: ${s.purpose ? oneLine(s.purpose) : "_Not described._"}`);
    out.push(`- ${s.kind === "Screen" ? "Who gets here" : "Opened from"}: ${s.arrival.length ? s.arrival.map(oneLine).join("; ") : "_Not known._"}`);
    if (s.kind !== "Screen") {
      out.push(`- Ways out: ${s.exits.length ? s.exits.join(", ") : "_None found._"}`);
      out.push(`- Completes with: ${s.completes.length ? s.completes.join(", ") : "_Nothing._"}`);
    }
    out.push("", "**Fields**", "", ...(s.fields.length ? s.fields.map((f) => `- "${oneLine(f.name)}" — ${f.role}${f.required ? ", required" : ""}`) : ["_None._"]));
    if (s.kind === "Wizard") out.push("", "**Steps**", "", ...(s.steps.length ? s.steps.map((st, i) => `${i + 1}. ${oneLine(st)}`) : ["_None._"]));
    out.push("", "**User can**", "", ...list(s.userCan));
    out.push("", "**User might**", "", ...list(s.userMight));
  }
  out.push("", "## Questions", "", ...list(model.questions), "");
  return out.join("\n");
}
