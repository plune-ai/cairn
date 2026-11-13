/**
 * MCP-E4 — the one door a tool call goes through. This is the only place in `src/mcp-test` that sends one: the guard
 * decides first (`McpCallGuard.admit`), and a refused call never reaches the server. A source test keeps it so: the
 * method name of the call request appears in this file only.
 *
 * The connection a runner builds hands this function a small `rpc` (it does not expose the SDK client), so code that
 * reads the server (`connect.ts`, `discover.ts`) has no way to send a call.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SENSITIVE } from "../api/guard.js";
import { type McpCallDecision, McpCallGuard } from "./guard.js";
import { maskSecrets } from "./secrets.js";

export const CALL_LOG_FILE = "mcp-calls.jsonl";
const ARGUMENT_TEXT_LIMIT = 300;
const ARGUMENT_DEPTH_LIMIT = 8;

export type CallOutcome = "ok" | "error" | "timeout" | "process-exit";

/** What a runner supplies to send one request on its connection. */
export interface ToolRpc {
  request(req: { method: string; params: Record<string, unknown> }, opts: { timeout: number; signal?: AbortSignal }): Promise<unknown>;
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

function outcomeOf(e: unknown): CallOutcome {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: string };
  if (code === -32001) return "timeout";
  if (code === -32000 || /Connection closed/i.test(message ?? "")) return "process-exit";
  return "error";
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
    response = await rpc.request(
      { method: "tools/call", params: { name: call.tool, arguments: call.arguments ?? {} } },
      { timeout: opts.callTimeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if ((response as { isError?: unknown } | null)?.isError === true) result = "error";
  } catch (e) {
    result = outcomeOf(e);
    const x = (e ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
    error = {
      name: typeof x.name === "string" ? x.name : "Error",
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
