/**
 * MCP-E1 — read the four lists of a server (tools, resources, resource templates, prompts) page by page.
 *
 * Paging is bounded: at most `maxPages` pages and `maxEntries` entries per list. A list that stops early is never
 * passed off as the whole list — it comes back with a {@link McpTruncation} naming the reason, and the model built
 * from it says `complete: false`. A server that keeps handing out a cursor, or hands out the same one twice, ends
 * at the limit the same way.
 */
import type {
  McpListKind,
  McpModel,
  McpPromptEntry,
  McpResourceEntry,
  McpResourceTemplateEntry,
  McpToolEntry,
  McpTruncation,
} from "./model.js";

export const DEFAULT_MAX_LIST_PAGES = 20;
export const DEFAULT_MAX_LIST_ENTRIES = 1000;

export interface ListPage {
  items: unknown[];
  nextCursor?: string | undefined;
}

/** What discovery needs from a connected server: the `initialize` answer and a way to read one page of a list. */
export interface DiscoverSource {
  serverInfo: { name: string; version: string; title?: string };
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  listPage(kind: McpListKind, cursor: string | undefined): Promise<ListPage>;
}

export interface DiscoverLimits {
  maxPages: number;
  maxEntries: number;
  /** When it aborts, reading stops and what was read so far is returned, marked incomplete. */
  signal?: AbortSignal;
}

/** Values nested deeper than this are replaced by {@link TOO_DEEP}: a server's schema must not decide how deep we recurse. */
export const MAX_NESTING = 64;
export const TOO_DEEP = "[nesting too deep]";

function capDepth(v: unknown, depth: number, hit: { cut: boolean }): unknown {
  if (!v || typeof v !== "object") return v;
  if (depth >= MAX_NESTING) {
    hit.cut = true;
    return TOO_DEEP;
  }
  if (Array.isArray(v)) return v.map((x) => capDepth(x, depth + 1, hit));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capDepth(x, depth + 1, hit)]));
}

type Obj = Record<string, unknown>;

/** The named string fields of `o`, those present only. */
function pickStrings(o: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (typeof o[k] === "string") out[k] = o[k];
  return out;
}

const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function toTool(raw: unknown, hit: { cut: boolean }): McpToolEntry {
  const o = asObj(raw);
  const obj = (v: unknown): Obj => asObj(capDepth(v, 0, hit));
  const t: McpToolEntry = { ...(pickStrings(o, ["name", "title", "description"]) as { name: string }), inputSchema: obj(o["inputSchema"]) };
  if (o["outputSchema"] !== undefined) t.outputSchema = obj(o["outputSchema"]);
  if (o["annotations"] !== undefined) t.annotations = obj(o["annotations"]);
  return t;
}

const toResource = (raw: unknown): McpResourceEntry => pickStrings(asObj(raw), ["uri", "name", "title", "description", "mimeType"]) as unknown as McpResourceEntry;
const toTemplate = (raw: unknown): McpResourceTemplateEntry =>
  pickStrings(asObj(raw), ["uriTemplate", "name", "title", "description", "mimeType"]) as unknown as McpResourceTemplateEntry;
function toPrompt(raw: unknown, hit: { cut: boolean }): McpPromptEntry {
  const o = asObj(raw);
  const p = pickStrings(o, ["name", "title", "description"]) as unknown as McpPromptEntry;
  if (Array.isArray(o["arguments"])) p.arguments = o["arguments"].map((a) => asObj(capDepth(a, 0, hit)));
  return p;
}

/** Which capability a list needs the server to have declared. */
const NEEDS: Record<McpListKind, string> = { tools: "tools", resources: "resources", resourceTemplates: "resources", prompts: "prompts" };

interface ReadList {
  items: unknown[];
  truncation?: McpTruncation;
}

async function readList(src: DiscoverSource, kind: McpListKind, limits: DiscoverLimits): Promise<ReadList> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    if (limits.signal?.aborted) return { items, truncation: { list: kind, reason: "interrupted", kept: items.length } };
    let res: ListPage;
    try {
      res = await src.listPage(kind, cursor);
    } catch (e) {
      const reason = limits.signal?.aborted ? "interrupted" : `page ${page} could not be read: ${(e as Error).message}`;
      return { items, truncation: { list: kind, reason, kept: items.length } };
    }
    const room = limits.maxEntries - items.length;
    const taken = res.items.slice(0, Math.max(room, 0));
    items.push(...taken);
    const more = res.nextCursor !== undefined && res.nextCursor !== "";
    if (taken.length < res.items.length) {
      return { items, truncation: { list: kind, reason: `entry limit of ${limits.maxEntries} reached`, kept: items.length } };
    }
    if (!more) return { items };
    if (seen.has(res.nextCursor as string)) {
      return { items, truncation: { list: kind, reason: "the server returned the same cursor twice", kept: items.length } };
    }
    if (items.length >= limits.maxEntries) {
      return { items, truncation: { list: kind, reason: `entry limit of ${limits.maxEntries} reached`, kept: items.length } };
    }
    if (page >= limits.maxPages) {
      return { items, truncation: { list: kind, reason: `page limit of ${limits.maxPages} reached`, kept: items.length } };
    }
    seen.add(res.nextCursor as string);
    cursor = res.nextCursor;
  }
}

/** The model of the server behind `src`, connection fields left for the caller to fill. */
export async function discoverModel(
  src: DiscoverSource,
  limits: DiscoverLimits,
  connection: McpModel["connection"],
): Promise<McpModel> {
  const truncated: McpTruncation[] = [];
  const notes: string[] = [];
  const read = async (kind: McpListKind): Promise<unknown[]> => {
    const need = NEEDS[kind];
    if (!(need in src.capabilities)) {
      if (kind === "tools") notes.push("The server did not declare the tools capability, so the tool list is empty and nothing was asked.");
      else if (kind !== "resourceTemplates") notes.push(`The server did not declare the ${need} capability; the ${kind} list was not asked.`);
      return [];
    }
    const r = await readList(src, kind, limits);
    if (r.truncation) truncated.push(r.truncation);
    return r.items;
  };
  /** Entries whose nesting was cut, by list. */
  const deep: Partial<Record<McpListKind, string[]>> = {};
  const convert = <T extends { name?: string }>(kind: McpListKind, items: unknown[], f: (raw: unknown, hit: { cut: boolean }) => T): T[] =>
    items.map((raw) => {
      const hit = { cut: false };
      const e = f(raw, hit);
      if (hit.cut) (deep[kind] ??= []).push(String(e.name ?? ""));
      return e;
    });
  const capHit = { cut: false };
  const capabilities = capDepth(src.capabilities, 0, capHit) as Record<string, unknown>;
  if (capHit.cut) truncated.push({ list: "capabilities", reason: `nesting deeper than ${MAX_NESTING} levels was cut`, kept: 0 });
  const tools = convert("tools", await read("tools"), toTool);
  const resources = (await read("resources")).map(toResource);
  const resourceTemplates = (await read("resourceTemplates")).map(toTemplate);
  const prompts = convert("prompts", await read("prompts"), toPrompt);
  for (const [kind, names] of Object.entries(deep) as Array<[McpListKind, string[]]>) {
    const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
    const kept = kind === "tools" ? tools.length : prompts.length;
    truncated.push({ list: kind, reason: `nesting deeper than ${MAX_NESTING} levels was cut in: ${shown}`, kept });
  }
  return {
    schemaVersion: 1,
    serverInfo: src.serverInfo,
    protocolVersion: src.protocolVersion,
    capabilities,
    complete: truncated.length === 0,
    truncated,
    notes,
    connection,
    tools,
    resources,
    resourceTemplates,
    prompts,
  };
}
