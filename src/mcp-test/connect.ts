/**
 * MCP-E1 — connect to a foreign MCP server (stdio process or Streamable HTTP) and read its `initialize` answer.
 *
 * The client is `@modelcontextprotocol/sdk`, imported lazily so the module stays off every other code path; when the
 * package is not installed the error says what to install instead of a raw ERR_MODULE_NOT_FOUND.
 *
 * Three promises are kept here:
 * - a stdio server never outlives the run: {@link McpConnection.close} reaps the process, and on Windows kills its
 *   process tree, whatever way the run ended (success, error, timeout, interrupt);
 * - the child gets only the SDK's default environment plus the `--env` values the user gave, never Cairn's own provider keys;
 * - an HTTP request goes to the origin the user named and nowhere else. Authentication metadata a server points to
 *   (a `WWW-Authenticate` header) is never visited and no token is sent there; the run stops with "authentication required".
 */
import { spawnSync } from "node:child_process";
import type { McpListKind } from "./model.js";
import type { DiscoverSource, ListPage } from "./discover.js";
import { safeText } from "./model.js";
import { maskCutTail, maskSecrets } from "./secrets.js";

export type McpTestErrorKind = "sdk-missing" | "spawn-failed" | "server-exited" | "no-response" | "auth-required" | "protocol" | "cancelled";

/** A reason a server could not be read. The message is for the console; mask it before printing. */
export class McpTestError extends Error {
  /** The stdio server's process id when one was started (already gone by the time this is thrown). */
  pid: number | null = null;
  /** What the server wrote to stderr before it failed, as is. */
  stderr = "";
  constructor(
    readonly kind: McpTestErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "McpTestError";
  }
}

export interface ConnectOptions {
  /** stdio: the command and its arguments. */
  command?: string[];
  /** Streamable HTTP: the server address. */
  url?: string;
  headers: Record<string, string>;
  /** Added to the SDK's default environment for the child. */
  env: Record<string, string>;
  cwd?: string;
  /** Limit for one request, in milliseconds. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Values to mask in what the server writes to stderr. */
  secrets?: readonly string[];
  /** Replaces `import()`; a test uses it to make the SDK look uninstalled. */
  importer?: (specifier: string) => Promise<unknown>;
}

export interface McpConnection {
  source: DiscoverSource;
  transport: "stdio" | "streamable-http";
  /** The stdio server's process id (null for HTTP). */
  pid: number | null;
  /** What the server wrote to stderr, as is (the caller masks it). */
  stderrText(): string;
  /** Ends the session and makes sure the server process is gone. */
  close(): Promise<void>;
}

const STDERR_CAP = 64 * 1024;
const REDIRECT_MESSAGE = "The server answered with a redirect; redirects are not followed.";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sdk = { Client: any; StdioClientTransport: any; StreamableHTTPClientTransport: any; ListToolsResultSchema: any };

const MISSING_HELP = "`cairn mcp-test` needs the MCP client package, which is not installed.\n  Install:  npm i @modelcontextprotocol/sdk";

async function loadSdk(importer: (s: string) => Promise<unknown>): Promise<Sdk> {
  try {
    const [client, stdio, http, types] = (await Promise.all([
      importer("@modelcontextprotocol/sdk/client/index.js"),
      importer("@modelcontextprotocol/sdk/client/stdio.js"),
      importer("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      importer("@modelcontextprotocol/sdk/types.js"),
    ])) as any[];
    return {
      Client: client.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
      ListToolsResultSchema: types.ListToolsResultSchema,
    };
  } catch (e) {
    const { code, message } = e as { code?: string; message?: string };
    // Only the package named as missing; an installed one whose own import failed is a different error.
    if (code === "ERR_MODULE_NOT_FOUND" && /['"]@modelcontextprotocol\/sdk\b/.test(message ?? "")) {
      throw new McpTestError("sdk-missing", MISSING_HELP);
    }
    throw e;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills `pid` and, on Windows, everything it started. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Waits a moment for `pid` to leave, then makes it. */
async function reap(pid: number | null): Promise<void> {
  if (pid === null) return;
  for (let i = 0; i < 10; i++) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  killTree(pid);
  for (let i = 0; i < 10 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
}

/** The `WWW-Authenticate` metadata address's origin, for the message; the address itself is never fetched. */
function metadataOrigin(header: string | null): string | undefined {
  const m = /resource_metadata="?([^",\s]+)/i.exec(header ?? "");
  if (!m) return undefined;
  try {
    return new URL(m[1] as string).origin;
  } catch {
    return undefined;
  }
}

function mapError(e: unknown, o: ConnectOptions, auth: { header: string | null }): McpTestError {
  if (e instanceof McpTestError) return e;
  if (o.signal?.aborted) return new McpTestError("cancelled", "Interrupted.");
  const err = e as { code?: unknown; message?: string; name?: string };
  const message = err.message ?? String(e);
  if (err.code === "ENOENT" && o.command) {
    const win = process.platform === "win32" ? " (on Windows a .cmd shim such as npx needs its extension: npx.cmd)" : "";
    return new McpTestError("spawn-failed", `Could not start the server: "${o.command[0]}" was not found${win}.`);
  }
  if (err.code === "EACCES" || err.code === "EPERM" || err.code === "ENOTDIR") {
    return new McpTestError("spawn-failed", `Could not start the server: ${safeText(message, 300)}`);
  }
  if (err.code === 401 || err.name === "UnauthorizedError") {
    const origin = metadataOrigin(auth.header);
    const other = origin && o.url && origin !== new URL(o.url).origin ? ` It points to authentication metadata at another origin (${origin}); that address was not visited and no token was sent there.` : "";
    return new McpTestError(
      "auth-required",
      `The server requires authentication (HTTP 401).${other} OAuth is not supported here; pass a token with --header "Authorization: Bearer <token>".`,
    );
  }
  if (err.code === -32001) {
    return new McpTestError("no-response", `The server did not answer within ${Math.round(o.timeoutMs / 1000)} s (--timeout).`);
  }
  if (err.code === -32000 || /Connection closed/i.test(message)) {
    return new McpTestError("server-exited", "The server closed the connection before it answered initialize.");
  }
  return new McpTestError("protocol", `The server's reply to initialize was not usable: ${safeText(message, 300)}`);
}

/** Connects, runs `initialize`, and returns what discovery needs. Any failure leaves no server process behind. */
export async function connectMcp(o: ConnectOptions): Promise<McpConnection> {
  const sdk = await loadSdk(o.importer ?? ((s) => import(s)));
  if (o.signal?.aborted) throw new McpTestError("cancelled", "Interrupted.");
  const auth: { header: string | null } = { header: null };
  const secrets = o.secrets ?? [];
  // Read a little past the cap, mask, then cut: a secret that straddles the cap is masked whole, never left as a prefix.
  const rawCap = STDERR_CAP + secrets.reduce((n, s) => Math.max(n, s.length), 0);
  let rawStderr = "";
  const stderrText = (): string => {
    const masked = maskSecrets(rawStderr, secrets);
    return (rawStderr.length >= rawCap ? maskCutTail(masked, secrets) : masked).slice(0, STDERR_CAP);
  };
  const isStdio = o.command !== undefined;
  let transport: any;
  if (isStdio) {
    const [command, ...args] = o.command as string[];
    transport = new sdk.StdioClientTransport({ command, args, env: o.env, ...(o.cwd ? { cwd: o.cwd } : {}), stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => {
      if (rawStderr.length < rawCap) rawStderr += chunk.toString("utf8").slice(0, rawCap - rawStderr.length);
    });
  } else {
    const url = new URL(o.url as string);
    // One origin only: whatever a server redirects or points to elsewhere is refused, with the headers it would carry.
    const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (target.origin !== url.origin) throw new Error(`refused to send a request to another origin (${target.origin})`);
      // Not followed, whatever the SDK's own policy: a redirect could carry the headers to another origin.
      const res = await fetch(input, { ...init, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new McpTestError("protocol", REDIRECT_MESSAGE);
      }
      if (res.status === 401) auth.header = res.headers.get("www-authenticate");
      return res;
    };
    transport = new sdk.StreamableHTTPClientTransport(url, { requestInit: { headers: o.headers }, fetch: guardedFetch });
  }

  let protocolVersion = "";
  const original = transport.setProtocolVersion?.bind(transport) as ((v: string) => void) | undefined;
  transport.setProtocolVersion = (v: string) => {
    protocolVersion = v;
    original?.(v);
  };

  const client = new sdk.Client({ name: "cairn-mcp-test", version: "0.0.0" }, { capabilities: {} });
  // A process that cannot start is reported to the transport's error hook, while connect() itself only sees "Connection closed".
  let startError: { code?: unknown } | undefined;
  client.onerror = (e: { code?: unknown }) => {
    if (typeof e?.code === "string") startError ??= e;
  };
  let pid: number | null = null;
  const close = async (): Promise<void> => {
    pid = transport.pid ?? pid;
    try {
      await client.close();
    } catch {
      /* closing a dead connection */
    }
    await reap(pid);
  };

  try {
    await client.connect(transport, { timeout: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    pid = transport.pid ?? pid;
    await close();
    const mapped = mapError(startError ?? e, o, auth);
    mapped.pid = pid;
    mapped.stderr = stderrText();
    throw mapped;
  }
  pid = transport.pid ?? null;

  const info = client.getServerVersion() ?? { name: "", version: "" };
  const reqOpts = { timeout: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) };
  const source: DiscoverSource = {
    serverInfo: {
      name: String(info.name ?? ""),
      version: String(info.version ?? ""),
      ...(typeof info.title === "string" ? { title: info.title } : {}),
    },
    protocolVersion,
    capabilities: client.getServerCapabilities() ?? {},
    async listPage(kind: McpListKind, cursor: string | undefined): Promise<ListPage> {
      const params = cursor === undefined ? undefined : { cursor };
      // tools/list goes through `request`: the SDK's own listTools also compiles every outputSchema, and one schema it
      // cannot compile would hide the whole list.
      const res =
        kind === "tools"
          ? await client.request({ method: "tools/list", params: params ?? {} }, sdk.ListToolsResultSchema, reqOpts)
          : kind === "resources"
            ? await client.listResources(params, reqOpts)
            : kind === "resourceTemplates"
              ? await client.listResourceTemplates(params, reqOpts)
              : await client.listPrompts(params, reqOpts);
      const items = (res[kind === "resourceTemplates" ? "resourceTemplates" : kind] ?? []) as unknown[];
      return { items, nextCursor: res.nextCursor };
    },
  };
  return {
    source,
    transport: isStdio ? "stdio" : "streamable-http",
    get pid() {
      return pid;
    },
    stderrText,
    close,
  };
}
