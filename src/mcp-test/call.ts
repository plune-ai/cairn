/**
 * MCP-E4 — the one door a tool call goes through. This is the only place in `src/mcp-test` that sends one: the guard
 * decides first (`McpCallGuard.admit`), and a refused call never reaches the server. A source test keeps it so: the
 * method name of the call request appears in this file only.
 *
 * The connection a runner builds hands this function a small `rpc` with one method, `invokeTool` (it does not expose the SDK
 * client or any generic sender), so code that reads the server (`discover.ts`) has no way to send a call.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SENSITIVE } from "../api/guard.js";
import { type McpCallDecision, McpCallGuard } from "./guard.js";
import { maskSecrets } from "./secrets.js";

export const CALL_LOG_FILE = "mcp-calls.jsonl";
const ARGUMENT_TEXT_LIMIT = 300;
const ARGUMENT_DEPTH_LIMIT = 8;

/** The method name of a tool call. It is written here and nowhere else; the connection takes it from here. */
export const TOOL_CALL_METHOD = "tools/call";

export type CallOutcome = "ok" | "error" | "timeout" | "process-exit" | "too-large";

/**
 * A call that failed because of something this side saw or did: its own timer fired, the connection was closed (the
 * transport said so), or the answer passed the size limit while it was read. Nothing the server SENT is ever turned into
 * one of these: a server may answer -32000, -32001 or the text "Connection closed" as an ordinary error, and that stays a
 * server answer.
 */
export class LocalFailure extends Error {
  constructor(
    readonly kind: "timeout" | "closed" | "too-large",
    message: string,
  ) {
    super(message);
    this.name = "LocalFailure";
  }
}

/** What a runner supplies to send one tool call on its connection (the one sending method; the connection builds the request). */
export interface ToolRpc {
  invokeTool(name: string, args: Record<string, unknown>, opts: { timeoutMs: number; maxBytes?: number; signal?: AbortSignal }): Promise<unknown>;
}

/** One line of `mcp-calls.jsonl`: a call that really went to the server. */
export interface SentCall {
  time: string;
  tool: string;
  style?: string;
  decision: "allowed";
  reason: string;
  /** The arguments, masked and shortened. */
  arguments: string;
  durationMs: number;
  result: CallOutcome;
}

export type GuardedCall =
  | { sent: false; decision: McpCallDecision }
  | { sent: true; decision: McpCallDecision; entry: SentCall; response?: unknown; error?: CallError };

/** What a failed call threw: the SDK's error name (a JSON-RPC error from the server is an `McpError`), its code and text. */
export interface CallError {
  name: string;
  code?: number | string;
  message: string;
}

export interface CallOptions {
  callTimeoutMs: number;
  /** Values to mask in the logged arguments. */
  secrets?: readonly string[];
  /** The most bytes of one answer that is read. */
  maxBytes?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** Receives the line to log for a call that was sent. */
  log?: (entry: SentCall) => Promise<void> | void;
}

/** The arguments as logged: values under sensitive keys and the given secrets masked, then shortened. */
export function describeArguments(args: unknown, secrets: readonly string[] = []): string {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return maskSecrets(v, secrets);
    if (!v || typeof v !== "object") return v;
    if (depth >= ARGUMENT_DEPTH_LIMIT) return "[nesting too deep]";
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "***" : walk(x, depth + 1)]));
  };
  const text = JSON.stringify(walk(args ?? {}, 0));
  // Cut on code points, so a surrogate pair is never split.
  const points = Array.from(text);
  return points.length > ARGUMENT_TEXT_LIMIT ? `${points.slice(0, ARGUMENT_TEXT_LIMIT - 1).join("")}…` : text;
}

/** Only a failure this side observed is a timeout, a closed connection or a too large answer; the code and text of an error the server sent decide nothing. */
function outcomeOf(e: unknown): CallOutcome {
  if (!(e instanceof LocalFailure)) return "error";
  return e.kind === "timeout" ? "timeout" : e.kind === "closed" ? "process-exit" : "too-large";
}

/**
 * Ask the guard, and only if it allows, send. A refusal comes back as `{ sent: false }` with the reason and nothing
 * is logged to the call journal (refusals go to the guard's report).
 */
export async function guardedToolCall(
  guard: McpCallGuard,
  rpc: ToolRpc,
  call: { tool: string; style?: string; arguments?: Record<string, unknown> },
  opts: CallOptions,
): Promise<GuardedCall> {
  const decision = await guard.admit({ tool: call.tool, ...(call.style ? { style: call.style } : {}) });
  if (!decision.allowed) return { sent: false, decision };
  const now = opts.now ?? Date.now;
  const started = now();
  let result: CallOutcome = "ok";
  let response: unknown;
  let error: CallError | undefined;
  try {
    response = await rpc.invokeTool(call.tool, call.arguments ?? {}, {
      timeoutMs: opts.callTimeoutMs,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if ((response as { isError?: unknown } | null)?.isError === true) result = "error";
  } catch (e) {
    result = outcomeOf(e);
    const x = (e ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
    error = {
      name: e instanceof LocalFailure ? "LocalFailure" : typeof x.name === "string" ? x.name : "Error",
      ...(typeof x.code === "number" || typeof x.code === "string" ? { code: x.code } : {}),
      message: typeof x.message === "string" ? x.message : String(e),
    };
  }
  const entry: SentCall = {
    time: new Date(started).toISOString(),
    tool: call.tool,
    ...(call.style ? { style: call.style } : {}),
    decision: "allowed",
    reason: decision.reason,
    arguments: describeArguments(call.arguments, opts.secrets),
    durationMs: Math.max(0, now() - started),
    result,
  };
  await opts.log?.(entry);
  return { sent: true, decision, entry, ...(response !== undefined ? { response } : {}), ...(error ? { error } : {}) };
}

/** Appends a sent call to `<dir>/mcp-calls.jsonl`. */
export async function appendCallLog(dir: string, entry: SentCall): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, CALL_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
}
