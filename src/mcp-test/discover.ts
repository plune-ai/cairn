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
}

type Obj = Record<string, unknown>;

/** The named string fields of `o`, those present only. */
function pickStrings(o: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (typeof o[k] === "string") out[k] = o[k];
  return out;
}

const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function toTool(raw: unknown): McpToolEntry {
  const o = asObj(raw);
  const t: McpToolEntry = { ...(pickStrings(o, ["name", "title", "description"]) as { name: string }), inputSchema: asObj(o["inputSchema"]) };
  if (o["outputSchema"] !== undefined) t.outputSchema = asObj(o["outputSchema"]);
  if (o["annotations"] !== undefined) t.annotations = asObj(o["annotations"]);
  return t;
}

const toResource = (raw: unknown): McpResourceEntry => pickStrings(asObj(raw), ["uri", "name", "title", "description", "mimeType"]) as unknown as McpResourceEntry;
const toTemplate = (raw: unknown): McpResourceTemplateEntry =>
  pickStrings(asObj(raw), ["uriTemplate", "name", "title", "description", "mimeType"]) as unknown as McpResourceTemplateEntry;
function toPrompt(raw: unknown): McpPromptEntry {
  const o = asObj(raw);
  const p = pickStrings(o, ["name", "title", "description"]) as unknown as McpPromptEntry;
  if (Array.isArray(o["arguments"])) p.arguments = o["arguments"].map(asObj);
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
    let res: ListPage;
    try {
      res = await src.listPage(kind, cursor);
    } catch (e) {
      const reason = `page ${page} could not be read: ${(e as Error).message}`;
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
  const tools = (await read("tools")).map(toTool);
  const resources = (await read("resources")).map(toResource);
  const resourceTemplates = (await read("resourceTemplates")).map(toTemplate);
  const prompts = (await read("prompts")).map(toPrompt);
  return {
    schemaVersion: 1,
    serverInfo: src.serverInfo,
    protocolVersion: src.protocolVersion,
    capabilities: src.capabilities,
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
