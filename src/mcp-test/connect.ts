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
import { StringDecoder } from "node:string_decoder";
import { LocalFailure, TOOL_CALL_METHOD } from "./call.js";
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
  /** The most bytes of one answer to a call that is read (default 256 KiB); a stdio message is cut off while it is read, never after it was parsed. */
  maxResponseBytes?: number;
  /** Replaces `import()`; a test uses it to make the SDK look uninstalled. */
  importer?: (specifier: string) => Promise<unknown>;
}

export interface McpConnection {
  source: DiscoverSource;
  transport: "stdio" | "streamable-http";
  /** The stdio server's process id (null for HTTP). */
  pid: number | null;
  /**
   * Sends one tool call (the only request this connection sends besides reading lists) and returns the answer as the server
   * sent it. A failure this side saw (its own timer, the transport closing, the answer passing `maxBytes` while it was read)
   * is thrown as a `LocalFailure`; whatever the server answered, a JSON-RPC error included, is thrown as it came.
   */
  invokeTool(name: string, args: Record<string, unknown>, opts: { timeoutMs: number; maxBytes?: number; signal?: AbortSignal }): Promise<unknown>;
  /** Bytes read from the server since the connection was made (stdout of the child, or response bodies). */
  readonly bytesRead: number;
  /** The transport reported that it closed, or the stdio child was stopped for an oversized message: no request can be answered any more. */
  readonly dead: boolean;
  /** Whether the stdio per-message size counter is installed (`unavailable`: only the transport's own limit applies). HTTP is always `active`. */
  readonly sizeCounter: "active" | "unavailable";
  /** What the server wrote to stderr, as is (the caller masks it). */
  stderrText(): string;
  /** Ends the session and makes sure the server process is gone. */
  close(): Promise<void>;
}

const STDERR_CAP = 64 * 1024;
/** The stdio reader refuses a message above this even when no limit is set (the SDK's own default is 10 MiB). */
const MIN_MESSAGE_CAP = 1024 * 1024;
export const DEFAULT_RESPONSE_BYTES = 256 * 1024;
/** The most bytes of one response to `initialize`, a list page or an SSE stream over HTTP (the limit of a call is separate). */
export const HANDSHAKE_LIMIT_BYTES = 8 * 1024 * 1024;
const REDIRECT_MESSAGE = "The server answered with a redirect; redirects are not followed.";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sdk = { Client: any; StdioClientTransport: any; StreamableHTTPClientTransport: any; ListToolsResultSchema: any; ResultSchema: any };

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
      ResultSchema: types.ResultSchema,
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

/**
 * Waits `graceMs` for `pid` to leave, then kills it (its tree on Windows) and waits until it is gone, so a returned run
 * means "no process left". `pid` null means the process was never known: nothing to do.
 */
export async function reap(pid: number | null, opts: { graceMs?: number; kill?: (pid: number) => void } = {}): Promise<void> {
  if (pid === null) return;
  const graceMs = opts.graceMs ?? 1000;
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  for (let waited = 0; waited < graceMs && alive(pid); waited += 50) await wait(50);
  if (!alive(pid)) return;
  (opts.kill ?? killTree)(pid);
  // The loop stays on the event loop, which is what collects the exit status of a child we started.
  for (let i = 0; i < 40 && alive(pid); i++) await wait(50);
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

function mapError(e: unknown, o: ConnectOptions, auth: { header: string | null }, local?: "timeout" | "closed"): McpTestError {
  if (e instanceof McpTestError) return e;
  if (o.signal?.aborted) return new McpTestError("cancelled", "Interrupted.");
  const err = e as { code?: unknown; message?: string; name?: string };
  const message = err.message ?? String(e);
  if (err.code === "ENOENT" && o.command) {
    const win = process.platform === "win32" ? " (on Windows a .cmd shim such as npx needs its extension: npx.cmd)" : "";
    return new McpTestError("spawn-failed", `Could not start the server: "${o.command[0]}" was not found${win}.`);
  }
  if (err.code === "EACCES" || err.code === "EPERM" || err.code === "ENOTDIR") {
    return new McpTestError("spawn-failed", `Could not start the server: ${safeText(maskSecrets(message, o.secrets ?? []), 300)}`);
  }
  if (err.code === 401 || err.name === "UnauthorizedError") {
    const origin = metadataOrigin(auth.header);
    const other = origin && o.url && origin !== new URL(o.url).origin ? ` It points to authentication metadata at another origin (${origin}); that address was not visited and no token was sent there.` : "";
    return new McpTestError(
      "auth-required",
      `The server requires authentication (HTTP 401).${other} OAuth is not supported here; pass a token with --header "Authorization: Bearer <token>".`,
    );
  }
  // Only a fact on this side says the server did not answer or closed the connection; a code in what it sent never does.
  if (local === "timeout") {
    return new McpTestError("no-response", `The server did not answer within ${Math.round(o.timeoutMs / 1000)} s (--timeout).`);
  }
  if (local === "closed") {
    return new McpTestError("server-exited", "The server closed the connection before it answered initialize.");
  }
  const code = typeof err.code === "number" ? ` (code ${err.code})` : "";
  return new McpTestError("protocol", `The server's reply to initialize was not usable${code}: ${safeText(maskSecrets(message, o.secrets ?? []), 300)}`);
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
  const decoder = new StringDecoder("utf8");
  const stderrText = (): string => {
    const masked = maskSecrets(rawStderr, secrets);
    return (rawStderr.length >= rawCap ? maskCutTail(masked, secrets) : masked).slice(0, STDERR_CAP);
  };
  const isStdio = o.command !== undefined;
  // What this side saw, read by `invokeTool`: the limit of the call in flight, an answer that passed it, bytes read.
  const state: { limit: number | undefined; tooLarge: boolean; bytesRead: number; closed: boolean; selfClose: boolean; tripped: boolean; counterMissing: boolean; abortCall: (() => void) | undefined } = { limit: undefined, tooLarge: false, bytesRead: 0, closed: false, selfClose: false, tripped: false, counterMissing: false, abortCall: undefined };
  let transport: any;
  let messageCap = MIN_MESSAGE_CAP;
  if (isStdio) {
    const [command, ...args] = o.command as string[];
    // The reader of the SDK stops at this many buffered bytes, before it parses a line: it reports an error and closes the child.
    const maxBufferSize = Math.max(o.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES, MIN_MESSAGE_CAP);
    messageCap = maxBufferSize;
    transport = new sdk.StdioClientTransport({ command, args, env: o.env, ...(o.cwd ? { cwd: o.cwd } : {}), stderr: "pipe", maxBufferSize });
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (rawStderr.length < rawCap) rawStderr += text.slice(0, rawCap - rawStderr.length);
    });
  } else {
    const url = new URL(o.url as string);
    // One origin only: whatever a server redirects or points to elsewhere is refused, with the headers it would carry.
    const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (target.origin !== url.origin) throw new Error(`refused to send a request to another origin (${target.origin})`);
      // Not followed, whatever the SDK's own policy: a redirect could carry the headers to another origin.
      const res = await fetch(input, { ...init, redirect: "manual" });
      const isStream = init?.method === "GET";
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new McpTestError("protocol", REDIRECT_MESSAGE);
      }
      if (res.status === 401) auth.header = res.headers.get("www-authenticate");
      return limitBody(res, isStream);
    };
    // Reads every body through a counter: past the limit of the call in flight (or the handshake limit for everything else) it
    // stops reading, fails the stream and ends the call that waits for it.
    const limitBody = (res: Response, isStream: boolean): Response => {
      const limit = state.limit ?? HANDSHAKE_LIMIT_BYTES;
      const source = res.body;
      if (!source) return res;
      const declared = Number(res.headers.get("content-length"));
      const reader = source.getReader();
      let seen = 0;
      const fail = async (): Promise<never> => {
        // A long-lived notification stream is cut too, but it is not the cause of a failed call.
        if (!isStream) {
          state.tooLarge = true;
          state.abortCall?.();
        }
        await reader.cancel().catch(() => undefined);
        throw new Error("the answer is over the size limit");
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          if (declared > limit && seen === 0) await fail().catch((e) => ctrl.error(e));
          else {
            const { done, value } = await reader.read();
            if (done) return ctrl.close();
            seen += value.byteLength;
            state.bytesRead += value.byteLength;
            if (seen > limit) return void (await fail().catch((e) => ctrl.error(e)));
            ctrl.enqueue(value);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
    transport = new sdk.StreamableHTTPClientTransport(url, { requestInit: { headers: o.headers }, fetch: guardedFetch });
  }

  // The process id is taken the moment the process is spawned. When `initialize` fails or is cut off, the SDK closes
  // the transport on its own, and transport.pid is empty by the time our code looks at it; without this the process
  // would never be reaped, and one that ignores SIGTERM would stay until the SDK's own SIGKILL, seconds later.
  let pid: number | null = null;
  if (isStdio) {
    const start = transport.start.bind(transport) as () => Promise<void>;
    transport.start = (): Promise<void> => {
      const started = start();
      pid = transport.pid ?? pid;
      // A counter beside the SDK's own reader: it only adds up what the child writes.
      // It also stops the flood: the SDK's reader only refuses to buffer, and its close waits for the child, which goes on writing.
      // A message (the bytes since the last newline) past the cap makes this side stop reading and kill the child at once.
      let line = 0;
      let killed = false;
      const stdout = transport._process?.stdout;
      // The counter reads a private field of the SDK transport; a version without it leaves only the transport's own limit.
      if (!stdout) state.counterMissing = true;
      stdout?.on("data", (chunk: Buffer) => {
        state.bytesRead += chunk.length;
        const nl = chunk.lastIndexOf(10);
        line = nl === -1 ? line + chunk.length : chunk.length - nl - 1;
        if (line > messageCap && !killed) {
          killed = true;
          state.tripped = true;
          state.tooLarge = true;
          state.abortCall?.();
          stdout.destroy();
          if (pid !== null) killTree(pid);
        }
      });
      return started;
    };
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
  client.onerror = (e: { code?: unknown; message?: string }) => {
    if (typeof e?.code === "string") startError ??= e;
    // The SDK's own reader refused a message over the cap (a local fact, raised by the transport, not an answer).
    if (e instanceof Error && /ReadBuffer exceeded maximum size/.test(e.message)) {
      state.tooLarge = true;
      state.tripped = true;
    }
  };
  // The transport said it closed: this is the only thing that makes a failed call "the connection is gone".
  // A close the transport was asked for (by our close(), or by the SDK after a failed connect) says nothing about the server:
  // an HTTP transport fires onclose at once when the SDK cleans up after an error ANSWER to initialize.
  const closeTransport = transport.close.bind(transport) as () => Promise<void>;
  transport.close = (): Promise<void> => {
    state.selfClose = true;
    return closeTransport();
  };
  client.onclose = () => {
    if (!state.selfClose) state.closed = true;
  };
  const close = async (): Promise<void> => {
    pid = transport.pid ?? pid;
    try {
      await client.close();
    } catch {
      /* closing a dead connection */
    }
    await reap(pid);
  };

  // `initialize` is timed by this side's own timer, so "did not answer" never rests on an error code the server sent.
  const initStop = new AbortController();
  let initTimedOut = false;
  const initTimer = setTimeout(() => {
    initTimedOut = true;
    initStop.abort();
  }, o.timeoutMs);
  const initForward = (): void => initStop.abort();
  o.signal?.addEventListener("abort", initForward, { once: true });
  try {
    await client.connect(transport, { timeout: o.timeoutMs + 60_000, signal: initStop.signal });
  } catch (e) {
    pid = transport.pid ?? pid;
    // Read before our own close, which also sets the flag.
    const local = initTimedOut ? "timeout" : state.closed ? "closed" : undefined;
    await close();
    const mapped = mapError(startError ?? e, o, auth, local);
    mapped.pid = pid;
    mapped.stderr = stderrText();
    throw mapped;
  } finally {
    clearTimeout(initTimer);
    o.signal?.removeEventListener("abort", initForward);
  }
  pid = transport.pid ?? null;

  const info = client.getServerVersion() ?? { name: "", version: "" };
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
      // A page that passes the handshake limit ends this request at once (the body counter calls `abortCall`).
      const stop = new AbortController();
      state.abortCall = () => stop.abort();
      const opts = { timeout: o.timeoutMs, signal: o.signal ? AbortSignal.any([o.signal, stop.signal]) : stop.signal };
      // tools/list goes through `request`: the SDK's own listTools also compiles every outputSchema, and one schema it
      // cannot compile would hide the whole list.
      let res;
      try {
        res =
          kind === "tools"
            ? await client.request({ method: "tools/list", params: params ?? {} }, sdk.ListToolsResultSchema, opts)
            : kind === "resources"
              ? await client.listResources(params, opts)
              : kind === "resourceTemplates"
                ? await client.listResourceTemplates(params, opts)
                : await client.listPrompts(params, opts);
      } finally {
        state.abortCall = undefined;
      }
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
    get bytesRead() {
      return state.bytesRead;
    },
    get dead() {
      return state.closed || state.tripped;
    },
    get sizeCounter() {
      return state.counterMissing ? "unavailable" : "active";
    },
    async invokeTool(name, args, opts) {
      const stop = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop.abort();
      }, opts.timeoutMs);
      const forward = (): void => stop.abort();
      opts.signal?.addEventListener("abort", forward, { once: true });
      state.limit = opts.maxBytes;
      state.tooLarge = false;
      state.abortCall = () => stop.abort();
      try {
        // The SDK's own timeout is set well past ours, so ours is the one that fires; an error code is never read as a timeout.
        return await client.request({ method: TOOL_CALL_METHOD, params: { name, arguments: args } }, sdk.ResultSchema, { signal: stop.signal, timeout: opts.timeoutMs + 60_000 });
      } catch (e) {
        // An error is a server answer ONLY when no local cause is set: size cap, closed transport, this side's abort, own timer.
        if (state.tooLarge) throw new LocalFailure("too-large", "the answer passed the size limit while it was read");
        if (state.closed) throw new LocalFailure("closed", "the connection was closed before an answer");
        if (opts.signal?.aborted && !timedOut) throw new LocalFailure("aborted", "the run was interrupted during the call");
        if (timedOut) throw new LocalFailure("timeout", "no answer within the call timeout");
        throw e;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", forward);
        state.limit = undefined;
        state.abortCall = undefined;
      }
    },
    stderrText,
    close,
  };
}
