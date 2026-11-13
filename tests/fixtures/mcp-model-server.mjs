// A small MCP server for the `cairn mcp-test` tests (MCP-E1), on the same `@modelcontextprotocol/sdk` the client uses.
// It speaks stdio when run as a program and Streamable HTTP when a test calls `startHttpFixture`.
//
// It lists tools with oneOf / anyOf / $ref + $defs / enum / required arguments / outputSchema / readOnlyHint, and it pages
// every list. Behaviour is chosen with environment variables (stdio) or options (HTTP):
//   FIXTURE_PAGE_SIZE     entries per page (default 2)
//   FIXTURE_MODE          normal | no-tools (declares no tools capability) | empty-tools | endless (a cursor on every page)
//                         | hang (never answers initialize, ignores stdin and SIGTERM) | exit-early (writes to stderr, exits 1)
//   FIXTURE_ORDER         forward | reverse (reverses every list and the key order inside every schema)
//   FIXTURE_PID_FILE      the process id is written here (so a test can look for a leftover process)
//   FIXTURE_ENV_FILE      the names of the environment variables the process received are written here, as JSON
//   FIXTURE_STDERR_TEXT   written to stderr at start
//   FIXTURE_STDERR_ENV    names (comma separated) of environment variables whose values are written to stderr after the pad, on one line
//   FIXTURE_STDERR_WORKFLOW=1  writes the lines `::error::x` and `##[group]y` to stderr
//   FIXTURE_NAME_ENV / FIXTURE_NAME_PAD  the serverInfo name is that many "n" characters followed by the value of that variable
//   FIXTURE_ERROR_ENV / FIXTURE_ERROR_PAD  (init-error) the error message is that many "e" characters followed by the value of that variable
//   FIXTURE_EXTRA=1       adds a tool `normal_x` and a resource with an application/json mime type
//   FIXTURE_STDERR_PAD    that many "x" characters are written to stderr first, without a newline
//   FIXTURE_SERVER_NAME   the serverInfo name (default fixture-server)
//   FIXTURE_ECHO_ENV      the name of an environment variable whose value is put into the description of `ping`
//   FIXTURE_LIST_DELAY_MS wait this long before each tools/list answer; FIXTURE_LIST_MARK is a file created at the first one
//   FIXTURE_MODE=init-error answers every request with a JSON-RPC error whose message holds control characters
// HTTP option `echoAuth` puts the received Authorization header into the description of `ping`, like a server that leaks it.
// The tools are never run by the tests; they exist to be listed.

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "search_notes",
    title: "Search notes",
    description: "Find notes by text.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["query"],
    },
    outputSchema: { type: "object", properties: { hits: { type: "array", items: { $ref: "#/$defs/hit" } } }, $defs: { hit: { type: "object", properties: { id: { type: "string" } } } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_note",
    description: "Create a note.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" }, kind: { enum: ["todo", "memo", "idea"] } },
      required: ["body", "kind"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "delete_note",
    description: "Delete a note for good.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "set_target",
    description: "Pick a target by id or by name.",
    inputSchema: {
      type: "object",
      properties: { target: { oneOf: [{ type: "string" }, { type: "integer" }] } },
      required: ["target"],
    },
  },
  {
    name: "tag_note",
    description: "Tag a note with one tag or several.",
    inputSchema: {
      type: "object",
      properties: { tags: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
    },
  },
  {
    name: "move_note",
    description: "Move a note to a folder.",
    inputSchema: {
      type: "object",
      properties: { from: { $ref: "#/$defs/folder" }, to: { $ref: "#/$defs/folder" } },
      required: ["from", "to"],
      $defs: { folder: { type: "string", pattern: "^[a-z]+$" } },
    },
  },
  { name: "ping", description: "Answers pong.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

// Added with the `extra` option: values a careless mask would damage (a name and a key equal to a common word, a number,
// a mime type).
const EXTRA_TOOL = {
  name: "normal_x",
  description: "A tool whose property is called like a common word.",
  inputSchema: { type: "object", properties: { normal: { type: "string", maxLength: 1000 } } },
};
const RESOURCES = [
  { uri: "note://inbox", name: "inbox", mimeType: "text/plain" },
  { uri: "note://archive", name: "archive", description: "Old notes." },
  { uri: "note://trash", name: "trash" },
];
const TEMPLATES = [
  { uriTemplate: "note://{id}", name: "note-by-id" },
  { uriTemplate: "folder://{name}/notes", name: "notes-in-folder" },
  { uriTemplate: "tag://{tag}", name: "notes-by-tag" },
];
const PROMPTS = [
  { name: "summarise", description: "Summarise a note.", arguments: [{ name: "id", required: true }] },
  { name: "daily-review", description: "Review the day." },
  { name: "weekly-review" },
];

function reverseKeys(v) {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])]));
  return v;
}

/** The SDK server, shaped by `opts` (same names as the environment variables, lower-cased and camel-cased). */
export function buildFixtureServer(opts = {}) {
  const pageSize = Number(opts.pageSize ?? 2);
  const mode = opts.mode ?? "normal";
  const reverse = opts.order === "reverse";
  const arrange = (list) => (reverse ? reverseKeys([...list].reverse()) : list);
  const capabilities = mode === "no-tools" ? { prompts: {} } : { tools: {}, resources: {}, prompts: {} };
  const server = new Server({ name: opts.serverName ?? "fixture-server", version: "1.2.3" }, { capabilities });

  const page = (list, cursor, endless = false) => {
    const start = cursor ? Number(cursor) : 0;
    const items = list.slice(start, start + pageSize);
    const next = endless ? String(start + pageSize) : start + pageSize < list.length ? String(start + pageSize) : undefined;
    return { items, next };
  };
  const withEcho = (list) => list.map((t) => (t.name === "ping" && opts.echo ? { ...t, description: `Answers pong. Called with: ${opts.echo}` } : t));
  const resourcesList = opts.extra ? [...RESOURCES, { uri: "note://data", name: "data", mimeType: "application/json" }] : RESOURCES;
  const toolsList = mode === "empty-tools" ? [] : mode === "endless" ? Array.from({ length: 500 }, (_, i) => ({ name: `tool_${String(i).padStart(3, "0")}`, inputSchema: { type: "object" } })) : withEcho(opts.extra ? [...TOOLS, EXTRA_TOOL] : TOOLS);
  if (mode !== "no-tools") {
    let marked = false;
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      if (opts.listMark && !marked) {
        marked = true;
        writeFileSync(opts.listMark, "listing");
      }
      if (opts.listDelayMs) await new Promise((r) => setTimeout(r, Number(opts.listDelayMs)));
      const { items, next } = page(arrange(toolsList), req.params?.cursor, mode === "endless");
      return { tools: items, ...(next ? { nextCursor: next } : {}) };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
      const { items, next } = page(arrange(resourcesList), req.params?.cursor);
      return { resources: items, ...(next ? { nextCursor: next } : {}) };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) => {
      const { items, next } = page(arrange(TEMPLATES), req.params?.cursor);
      return { resourceTemplates: items, ...(next ? { nextCursor: next } : {}) };
    });
  }
  server.setRequestHandler(ListPromptsRequestSchema, async (req) => {
    const { items, next } = page(arrange(PROMPTS), req.params?.cursor);
    return { prompts: items, ...(next ? { nextCursor: next } : {}) };
  });
  return server;
}

/**
 * Starts the fixture over Streamable HTTP on a free local port (stateless: one server per request).
 * `seen` collects what each request carried; `requireAuth` answers 401 to a request without that Authorization value,
 * with a `WWW-Authenticate` header that points at `metadataUrl`.
 */
export async function startHttpFixture(opts = {}) {
  const seen = [];
  const http = createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, headers: req.headers });
    if (opts.redirectTo) {
      res.writeHead(302, { Location: opts.redirectTo });
      res.end();
      return;
    }
    if (opts.requireAuth && req.headers.authorization !== opts.requireAuth) {
      const meta = opts.metadataUrl ? ` resource_metadata="${opts.metadataUrl}"` : "";
      res.writeHead(401, { "WWW-Authenticate": `Bearer${meta}`, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const echo = opts.echoHeader ? req.headers[String(opts.echoHeader).toLowerCase()] : opts.echoAuth ? req.headers.authorization : undefined;
    const server = buildFixtureServer({ ...opts, echo });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => (http.closeAllConnections?.(), http.close(() => resolve()))),
  };
}

/** A server that records every request and answers 404: stands in for an address the client must not visit. */
export async function startWatchServer() {
  const seen = [];
  const http = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, headers: req.headers });
    res.writeHead(404).end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => (http.closeAllConnections?.(), http.close(() => resolve()))) };
}

async function main() {
  const env = process.env;
  if (env.FIXTURE_PID_FILE) writeFileSync(env.FIXTURE_PID_FILE, String(process.pid));
  if (env.FIXTURE_ENV_FILE) writeFileSync(env.FIXTURE_ENV_FILE, JSON.stringify(Object.keys(env).sort()));
  if (env.FIXTURE_STDERR_PAD) process.stderr.write("x".repeat(Number(env.FIXTURE_STDERR_PAD)));
  if (env.FIXTURE_STDERR_TEXT) process.stderr.write(`${env.FIXTURE_STDERR_TEXT}\n`);
  if (env.FIXTURE_STDERR_ENV) process.stderr.write(`starting with key ${env.FIXTURE_STDERR_ENV.split(",").map((n) => env[n]).join(" ")}\n`);
  if (env.FIXTURE_STDERR_WORKFLOW) process.stderr.write("::error::x\n##[group]y\n");
  const mode = env.FIXTURE_MODE ?? "normal";
  if (mode === "exit-early") process.exit(1);
  if (mode === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "init-error") {
    createInterface({ input: process.stdin }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        const message = env.FIXTURE_ERROR_ENV ? "e".repeat(Number(env.FIXTURE_ERROR_PAD ?? 0)) + env[env.FIXTURE_ERROR_ENV] : "\u001b[2J\n::error::x";
        const error = { code: -32603, message };
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error })}\n`);
      }
    });
    return;
  }
  const server = buildFixtureServer({
    pageSize: env.FIXTURE_PAGE_SIZE,
    mode,
    order: env.FIXTURE_ORDER,
    serverName: env.FIXTURE_NAME_ENV ? "n".repeat(Number(env.FIXTURE_NAME_PAD ?? 0)) + env[env.FIXTURE_NAME_ENV] : env.FIXTURE_SERVER_NAME,
    extra: env.FIXTURE_EXTRA === "1",
    echo: env.FIXTURE_ECHO_ENV ? env[env.FIXTURE_ECHO_ENV] : undefined,
    listDelayMs: env.FIXTURE_LIST_DELAY_MS,
    listMark: env.FIXTURE_LIST_MARK,
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
