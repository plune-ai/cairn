/**
 * MCP-E1 — the model of a foreign MCP server: what it declared and what it lists.
 *
 * Everything in here is read from the server, so it is untrusted text: nothing is executed or handed to a model as an
 * instruction, and every line printed to the console goes through {@link safeText}.
 *
 * The file written from this model must be the same bytes for the same server, so {@link serializeModel} sorts every
 * object key and every list by name, and the model carries no time, run id or anything that depends on the network.
 */

export const MCP_MODEL_VERSION = 1;

export interface McpToolEntry {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpResourceEntry {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateEntry {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptEntry {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<Record<string, unknown>>;
}

export type McpListKind = "tools" | "resources" | "resourceTemplates" | "prompts";

/** A list that stopped before the server's last page. */
export interface McpTruncation {
  list: McpListKind;
  reason: string;
  /** How many entries were kept. */
  kept: number;
}

export interface McpModel {
  schemaVersion: typeof MCP_MODEL_VERSION;
  serverInfo: { name: string; version: string; title?: string };
  /** The protocol revision the server agreed to in `initialize`. */
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  /** false when any list was cut short; `truncated` says which and why. */
  complete: boolean;
  truncated: McpTruncation[];
  /** Plain statements about what could not be read (a list the server did not declare, for one). */
  notes: string[];
  /** Names only: the values of headers and environment variables are never stored. */
  connection: { transport: "stdio" | "streamable-http"; headerNames: string[]; envNames: string[] };
  tools: McpToolEntry[];
  resources: McpResourceEntry[];
  resourceTemplates: McpResourceTemplateEntry[];
  prompts: McpPromptEntry[];
}

/** The same value with every object key in code-point order (arrays keep their order). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return value;
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T): number => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The model with its lists in name order, ready to be written. */
export function canonicalModel(m: McpModel): McpModel {
  return {
    ...m,
    connection: { ...m.connection, headerNames: [...m.connection.headerNames].sort(), envNames: [...m.connection.envNames].sort() },
    truncated: [...m.truncated].sort(byKey((t) => t.list)),
    tools: [...m.tools].sort(byKey((t) => t.name)),
    resources: [...m.resources].sort(byKey((r) => r.uri)),
    resourceTemplates: [...m.resourceTemplates].sort(byKey((r) => r.uriTemplate)),
    prompts: [...m.prompts].sort(byKey((p) => p.name)),
  };
}

/** The exact text of `mcp-model.json`. */
export function serializeModel(m: McpModel): string {
  return `${JSON.stringify(sortKeys(canonicalModel(m)), null, 2)}\n`;
}

/** Text from a server made printable: control characters (escape sequences included) become a space, length is capped. */
export function safeText(text: unknown, max = 80): string {
  const s = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function hasProperties(schema: Record<string, unknown>): boolean {
  const p = schema["properties"];
  return !!p && typeof p === "object" && Object.keys(p).length > 0;
}

/** The short summary printed after a read: counts, which tools take arguments, which declared `readOnlyHint`. */
export function renderModelSummary(m: McpModel): string[] {
  const withProps = m.tools.filter((t) => hasProperties(t.inputSchema));
  const without = m.tools.filter((t) => !hasProperties(t.inputSchema));
  const readOnly = m.tools.filter((t) => t.annotations?.["readOnlyHint"] === true);
  const names = (xs: McpToolEntry[]): string => (xs.length ? xs.map((t) => safeText(t.name, 60)).join(", ") : "none");
  const lines = [
    `MCP server: ${safeText(m.serverInfo.name)} ${safeText(m.serverInfo.version)} (protocol ${safeText(m.protocolVersion)})`,
    `  ${m.tools.length} tool(s), ${m.resources.length} resource(s), ${m.resourceTemplates.length} resource template(s), ${m.prompts.length} prompt(s)`,
    `  Tools with an inputSchema that has properties: ${withProps.length} (${names(withProps)})`,
    `  Tools without properties: ${without.length} (${names(without)})`,
    `  Tools that declared readOnlyHint: ${readOnly.length} (${names(readOnly)})`,
  ];
  for (const t of m.truncated) {
    lines.push(`  ⚠ The ${t.list} list is INCOMPLETE: ${t.reason} (${t.kept} kept). The model has complete: false.`);
  }
  for (const n of m.notes) lines.push(`  Note: ${n}`);
  return lines;
}
