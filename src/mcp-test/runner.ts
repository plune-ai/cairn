/**
 * MCP-E5 — runs the cases against the server, one at a time, through the call guard, and judges each answer by a rule
 * the case's own `expect` states.
 *
 * States (the same five everywhere): `passed`, `failed`, `not-sent` (the guard refused), `could-not-run` (no answer, or
 * an answer that cannot be judged), `needs-review` (an answer a rule cannot judge; a person must). A case is never
 * `passed` because nothing went wrong: it needs an answer that meets its expectation.
 *
 * Calls are never repeated. A repeated tool call could repeat a side effect, so a case that gets no answer stays
 * `could-not-run`. The only repeated thing is the connection to a stdio server that died: one new start, a second death
 * stops the run.
 *
 * Everything an answer holds is untrusted: it is measured before it is kept, masked before it is cut, and only the cut,
 * masked text is shown or searched for advice. Advice never changes a state.
 */
import { SENSITIVE } from "../api/guard.js";
import type { ApiCaseTechnique } from "../api/cases.js";
import { findAdvice, type AdviceFinding } from "./advice.js";
import { guardedToolCall, appendCallLog, type CallError, type ToolRpc } from "./call.js";
import type { McpCallGuard } from "./guard.js";
import { safeText, type McpToolEntry } from "./model.js";
import { OracleHost, scanSchema } from "./schema.js";
import { maskSecrets } from "./secrets.js";

export type CaseState = "passed" | "failed" | "not-sent" | "could-not-run" | "needs-review";
export const CASE_STATES: readonly CaseState[] = ["passed", "failed", "not-sent", "could-not-run", "needs-review"];

/** The most of an answer that is kept and compared (bytes of its JSON). */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
/** The most characters of an answer written as evidence. */
export const EVIDENCE_TEXT_LIMIT = 4000;
/** This many cases in a row without an answer stop the run. */
export const MAX_SILENT_IN_A_ROW = 3;

type Obj = Record<string, unknown>;

export interface RunnableCase {
  name: string;
  stableId: string;
  tool: string;
  kind: string;
  type: "Positive" | "Negative";
  args: Obj;
  technique?: ApiCaseTechnique;
  rationale?: string;
  /** `psycho` or `hacker` for an adversarial case: the guard treats those as mutating. */
  style?: string;
  /** Whether the payload was handled safely is for a person to say: such a case never passes by itself. */
  humanOracle?: boolean;
  expect:
    | { outcome: "success"; outputSchema?: boolean }
    | { outcome: "rejected"; forms?: ReadonlyArray<{ jsonRpcErrorCode: number } | { resultIsError: true }> }
    | { outcome: "robust"; failedWhen: readonly string[]; accepts?: readonly string[] };
}

export interface CaseResult {
  name: string;
  stableId: string;
  tool: string;
  kind: string;
  type: string;
  style?: string;
  state: CaseState;
  reason: string;
  durationMs?: number;
  /** The arguments that were sent, masked and shortened. */
  request?: string;
  /** The answer, masked and cut; absent when it was too large to keep. */
  response?: string;
  responseBytes?: number;
  truncated?: boolean;
  /** Only when no answer came. */
  error?: string;
  observations: string[];
  advice: AdviceFinding[];
  humanOracle?: boolean;
  /** The JSON-RPC error code the server answered, when it answered one. */
  rpcCode?: number;
  /** The server was started again earlier in this run: it had lost whatever state the earlier cases made. */
  afterRestart?: true;
}

/** A connection the runner can ask: the current one, and how to start the server again (stdio only). */
export interface Link {
  invokeTool: ToolRpc["invokeTool"];
  transport: "stdio" | "streamable-http";
  /** The transport closed (or the stdio child was stopped): the connection cannot answer any more. */
  dead?: () => boolean;
  /** Reads this connection's tool list again (a new connection brings its own). */
  relist?: () => Promise<McpToolEntry[]>;
}

export interface RunnerOptions {
  guard: McpCallGuard;
  /** The tools as listed when the user looked: their outputSchemas decide what a result must hold. */
  tools: readonly McpToolEntry[];
  link: Link;
  /** Starts a stdio server again after it died; returns the new link, or undefined when it cannot. */
  restart?: () => Promise<Link | { error: string } | undefined>;
  /** Reads the tool list again (called before the first case of each tool, and after a restart). */
  relist?: () => Promise<McpToolEntry[]>;
  callTimeoutMs: number;
  maxResponseBytes?: number;
  secrets?: readonly string[];
  /** Where `mcp-calls.jsonl` goes. */
  logDir?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  results: CaseResult[];
  /** Why the run ended before the last case, if it did. */
  stopped?: string;
  restarts: number;
}

type Anomaly = "process-exit" | "connection-closed" | "timeout" | "http-5xx";

type Answer =
  | { kind: "aborted" }
  | { kind: "too-large" }
  | { kind: "result"; result: Obj; bytes: number; truncated: boolean }
  | { kind: "rpc-error"; code: number; message: string }
  | { kind: "anomaly"; anomaly: Anomaly; message: string }
  | { kind: "unjudgeable"; message: string };

function classify(transport: Link["transport"], outcome: string, error: CallError | undefined, response: unknown, max: number): Answer {
  if (outcome === "aborted") return { kind: "aborted" };
  if (outcome === "too-large") return { kind: "too-large" };
  if (outcome === "timeout") return { kind: "anomaly", anomaly: "timeout", message: "no answer within the call timeout" };
  if (outcome === "process-exit") {
    return transport === "stdio"
      ? { kind: "anomaly", anomaly: "process-exit", message: "the server process exited during the call" }
      : { kind: "anomaly", anomaly: "connection-closed", message: "the connection was closed before an answer" };
  }
  if (error) {
    const code = typeof error.code === "number" ? error.code : undefined;
    if (error.name === "McpError" && code !== undefined) return { kind: "rpc-error", code, message: error.message };
    if (error.name === "StreamableHTTPError" && code !== undefined) {
      if (code >= 500) return { kind: "anomaly", anomaly: "http-5xx", message: `HTTP ${code}` };
      return { kind: "unjudgeable", message: `HTTP ${code}` };
    }
    return { kind: "unjudgeable", message: "transport error" };
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) return { kind: "unjudgeable", message: "the answer is not an object" };
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  } catch {
    return { kind: "unjudgeable", message: "the answer cannot be read as JSON" };
  }
  return { kind: "result", result: response as Obj, bytes, truncated: bytes > max };
}

/** The value with sensitive keys and given secrets masked, depth-limited. */
function maskDeep(v: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof v === "string") return maskSecrets(v, secrets);
  if (!v || typeof v !== "object") return v;
  if (depth >= 40) return "[nesting too deep]";
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, secrets, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "***" : maskDeep(x, secrets, depth + 1)]));
}

/** Masked first, then cut: a secret that straddles the cut is never left as a prefix. */
function evidenceText(v: unknown, secrets: readonly string[]): string {
  return safeText(JSON.stringify(maskDeep(v, secrets)) ?? "", EVIDENCE_TEXT_LIMIT);
}

/** Advice only advises: a failure in it loses the advice, never a result. */
function adviceOf(text: string): AdviceFinding[] {
  try {
    return findAdvice(text);
  } catch {
    return [];
  }
}

function isErrorResult(r: Obj): boolean {
  return r["isError"] === true;
}

/** What a Negative case lists as a refusal: JSON-RPC error codes, and whether an error result counts. A case without a list means -32602 or isError. */
function rejectionForms(forms: ReadonlyArray<{ jsonRpcErrorCode: number } | { resultIsError: true }> | undefined): { codes: number[]; isError: boolean } {
  const list = forms ?? [{ jsonRpcErrorCode: -32602 }, { resultIsError: true as const }];
  return { codes: list.flatMap((f) => ("jsonRpcErrorCode" in f ? [f.jsonRpcErrorCode] : [])), isError: list.some((f) => "resultIsError" in f) };
}

const DEFAULT_ACCEPTS = ["json-rpc-error", "result-isError", "accepted-without-harm"];
const acceptsOf = (e: { accepts?: readonly string[] }): readonly string[] => e.accepts ?? DEFAULT_ACCEPTS;

export async function runCases(cases: readonly RunnableCase[], o: RunnerOptions): Promise<RunResult> {
  const secrets = o.secrets ?? [];
  const max = o.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const host = new OracleHost();
  const toolByName = new Map(o.tools.map((t) => [t.name, t]));
  const results: CaseResult[] = [];
  let link = o.link;
  let afterRestart = false;
  let alive = true; // an answer (or the start of this connection) was seen since the last silence
  let silent = 0;
  let crashes = 0;
  let restarts = 0;
  let stopped: string | undefined;

  /** The server process is gone (it exited, or was stopped for an oversized message): one restart budget for every cause. */
  const lose = async (): Promise<void> => {
    crashes += 1;
    if (crashes >= 2) {
      stopped = "the server process was lost twice (exited or stopped); the run was stopped";
      return;
    }
    if (link.transport !== "stdio" || !o.restart) {
      stopped = "the server connection is gone; the run was stopped";
      return;
    }
    const next = await o.restart();
    if (next && !("error" in next)) {
      link = next;
      restarts += 1;
      afterRestart = true;
      alive = true;
      silent = 0;
    } else stopped = next ? `the server could not be started again (${safeText(maskSecrets(next.error, secrets), 200)}); the run was stopped` : "the server process could not be started again; the run was stopped";
  };

  const finish = (c: RunnableCase, state: CaseState, reason: string, extra: Partial<CaseResult> = {}): void => {
    results.push({
      name: c.name,
      stableId: c.stableId,
      tool: c.tool,
      kind: c.kind,
      type: c.type,
      ...(c.style ? { style: c.style } : {}),
      state,
      reason,
      observations: [],
      advice: [],
      ...(c.humanOracle ? { humanOracle: true } : {}),
      ...(afterRestart ? { afterRestart: true as const } : {}),
      ...extra,
    });
  };

  /** The output check of a successful result: undefined when it holds, else the verdict. */
  // One validator per tool, built once; a tool whose schema could not be built or timed out is not checked again in this run.
  type Compiled = { oracle: ReturnType<OracleHost["oracle"]>; generation: number } | { unchecked: string };
  const compiled = new Map<string, Compiled>();
  const unchecked = (what: string): string => `the outputSchema could not be checked (${safeText(maskSecrets(what, secrets), 120)})`;
  const checkOutput = async (tool: McpToolEntry | undefined, result: Obj): Promise<{ state: CaseState; reason: string } | undefined> => {
    const schema = tool?.outputSchema;
    if (!schema || !tool) return undefined;
    if (result["structuredContent"] === undefined) return { state: "failed", reason: "the tool declares an outputSchema but the result has no structuredContent" };
    let entry = compiled.get(tool.name);
    // A timeout for another tool restarted the worker, and a validator of the old one is gone: build this one again.
    if (!entry || ("oracle" in entry && entry.generation !== host.generation)) {
      const problem = scanSchema(schema);
      if (problem) entry = { unchecked: unchecked(`${problem.keyword}: ${problem.message}`) };
      else {
        try {
          entry = { oracle: host.oracle(schema, { perCheck: true }), generation: host.generation };
        } catch (e) {
          entry = { unchecked: unchecked((e as Error).message) };
        }
      }
      compiled.set(tool.name, entry);
    }
    if ("unchecked" in entry) return { state: "needs-review", reason: entry.unchecked };
    try {
      const valid = entry.oracle.check(result["structuredContent"]).valid;
      return valid ? undefined : { state: "failed", reason: "structuredContent does not match the tool's outputSchema" };
    } catch (e) {
      const reason = unchecked((e as Error).message);
      compiled.set(tool.name, { unchecked: reason });
      return { state: "needs-review", reason };
    }
  };

  try {
    for (const c of cases) {
      if (stopped || o.signal?.aborted) {
        finish(c, "could-not-run", stopped ?? "interrupted");
        continue;
      }
      // The tool is read again before EVERY call: one that changed since the user looked is refused by the guard, and a list
      // that cannot be read (or is cut short) means the call is not sent. The read takes a rate slot but no call of the budget.
      const relist = link.relist ?? o.relist;
      // Not when a budget is already spent: the guard refuses the call below, and a re-read first would only make that late.
      if (relist && o.guard.budgetLeft() && o.guard.decide({ tool: c.tool, ...(c.style ? { style: c.style } : {}) }).allowed) {
        await o.guard.waitSlot();
        try {
          o.guard.observe(await relist());
        } catch {
          // A re-read that fails is a local failure, never a refusal by the guard: the case did not run, and a dead connection
          // is handled as the process failure it is (the one restart, then stop).
          finish(c, "could-not-run", "the tool list could not be re-read, so the call was not sent");
          if (o.signal?.aborted) stopped = "interrupted";
          else if (link.dead?.()) await lose();
          else {
            silent += 1;
            if (silent >= MAX_SILENT_IN_A_ROW) stopped = `${MAX_SILENT_IN_A_ROW} cases in a row got no answer; the run was stopped`;
          }
          continue;
        }
      }
      const call = await guardedToolCall(o.guard, link, { tool: c.tool, ...(c.style ? { style: c.style } : {}), arguments: c.args }, {
        callTimeoutMs: o.callTimeoutMs,
        maxBytes: max,
        secrets,
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.logDir ? { log: (e) => appendCallLog(o.logDir as string, e) } : {}),
      });
      if (!call.sent) {
        // The guard did not refuse the case itself: the run's time ran out before its turn.
        if (call.decision.reason === "time budget exhausted") finish(c, "could-not-run", "the time budget ran out before this case was sent (--time-budget)");
        else finish(c, "not-sent", `the call guard refused it: ${call.decision.reason}`);
        continue;
      }
      const answer = classify(link.transport, call.entry.result, call.error, call.response, max);
      const base: Partial<CaseResult> = { durationMs: call.entry.durationMs, request: call.entry.arguments };

      if (answer.kind === "aborted") {
        finish(c, "could-not-run", "the run was interrupted during the call", base);
        stopped = "interrupted";
        continue;
      }
      if (answer.kind === "too-large") {
        // The server did answer; the answer was cut off while it was read. A stdio connection was closed to stop the flood.
        alive = true;
        silent = 0;
        finish(c, "needs-review", "the answer is larger than the limit and was not read to the end", { ...base, truncated: true, observations: [`answer passed the ${max} byte limit while it was read`] });
        // A stdio child was stopped to end the flood: that is a lost process, with the same one restart as an exit.
        if (link.transport === "stdio") await lose();
        continue;
      }
      if (answer.kind === "anomaly") {
        const aliveBefore = alive;
        alive = false;
        silent += 1;
        const failedWhen = c.expect.outcome === "robust" ? c.expect.failedWhen : [];
        // The case is at fault only if the server was answering just before it (a process exit counts for every case).
        const atFault = aliveBefore && (answer.anomaly === "process-exit" || failedWhen.includes(answer.anomaly));
        finish(c, atFault ? "failed" : "could-not-run", atFault ? `${answer.message} (the server was answering before this case)` : `${answer.message}${aliveBefore ? "" : "; the server was not answering before this case"}`, { ...base, error: safeText(maskSecrets(answer.message, secrets), 200) });
        if (answer.anomaly === "process-exit") await lose();
        else if (silent >= MAX_SILENT_IN_A_ROW) stopped = `${MAX_SILENT_IN_A_ROW} cases in a row got no answer; the run was stopped`;
        continue;
      }
      if (answer.kind === "unjudgeable") {
        silent += 1;
        alive = false;
        finish(c, "could-not-run", answer.message, { ...base, error: safeText(maskSecrets(answer.message, secrets), 200) });
        if (silent >= MAX_SILENT_IN_A_ROW) stopped = `${MAX_SILENT_IN_A_ROW} cases in a row got no answer; the run was stopped`;
        continue;
      }
      // An answer came, so the server is alive.
      alive = true;
      silent = 0;
      const observations: string[] = [];
      const answered = (state: CaseState, reason: string, extra: Partial<CaseResult> = {}): void => {
        finish(c, state, reason, { ...base, observations, ...extra });
      };

      if (answer.kind === "rpc-error") {
        const text = evidenceText({ code: answer.code, message: answer.message }, secrets);
        const advice = adviceOf(text);
        const extra = { response: text, advice, rpcCode: answer.code };
        const e = c.expect;
        if (e.outcome === "rejected") {
          const listed = rejectionForms(e.forms).codes;
          if (listed.includes(answer.code)) answered("passed", `refused with a JSON-RPC error (${answer.code})`, extra);
          else answered("needs-review", `refused with JSON-RPC error ${answer.code}, which the case does not list (${listed.join(", ")}): the server refused, but not for the stated reason`, extra);
        } else if (e.outcome === "robust") {
          if (!acceptsOf(e).includes("json-rpc-error")) answered("needs-review", `answered JSON-RPC error ${answer.code}, which the case does not accept as a safe answer`, extra);
          else answered(c.humanOracle ? "needs-review" : "passed", c.humanOracle ? `refused with a JSON-RPC error (${answer.code}); whether the payload was handled safely needs a person` : `refused with a JSON-RPC error (${answer.code})`, extra);
        } else answered("failed", `the server answered a JSON-RPC error (${answer.code}) to a value its schema allows`, extra);
        continue;
      }

      // A result.
      const r = answer.result;
      observations.push(`answer ${answer.bytes} bytes in ${call.entry.durationMs} ms`);
      const content = r["content"];
      if (!isErrorResult(r) && Array.isArray(content) && content.length === 0 && r["structuredContent"] === undefined) observations.push("empty content");
      if (!isErrorResult(r) && r["structuredContent"] === undefined && Array.isArray(content) && content.length > 0 && !toolByName.get(c.tool)?.outputSchema) observations.push("text only, no structuredContent");
      let extra: Partial<CaseResult> = { responseBytes: answer.bytes };
      if (answer.truncated) {
        observations.push(`answer larger than the ${max} byte limit: not kept`);
        extra = { ...extra, truncated: true };
      } else {
        const text = evidenceText(r, secrets);
        extra = { ...extra, response: text };
        if (isErrorResult(r)) extra = { ...extra, advice: adviceOf(text) };
      }
      const e = c.expect;
      if (e.outcome === "rejected") {
        if (answer.truncated) answered("needs-review", "the answer is larger than the limit and was not kept", extra);
        else if (isErrorResult(r)) {
          if (rejectionForms(e.forms).isError) answered("passed", "refused with an error result (isError)", extra);
          else answered("needs-review", "refused with an error result (isError), which the case does not list: it expects a JSON-RPC error", extra);
        } else answered("failed", "the server accepted a value that violates its schema", extra);
        continue;
      }
      if (e.outcome === "robust") {
        const accepts = acceptsOf(e);
        if (answer.truncated) answered("needs-review", "the answer is larger than the limit and was not kept", extra);
        else if (isErrorResult(r) && !accepts.includes("result-isError")) answered("needs-review", "answered with an error result (isError), which the case does not accept as a safe answer", extra);
        else if (!isErrorResult(r) && !accepts.includes("accepted-without-harm")) answered("needs-review", "the server accepted the value, which the case does not accept as a safe answer", extra);
        else if (c.humanOracle) answered("needs-review", "the server answered; whether the payload was handled safely needs a person", extra);
        else answered("passed", isErrorResult(r) ? "refused with an error result (isError)" : "accepted; no failure seen", extra);
        continue;
      }
      // Positive
      if (isErrorResult(r)) {
        answered("needs-review", "isError on a synthesised value: the server may refuse it for a business reason", extra);
        continue;
      }
      if (answer.truncated) {
        answered("needs-review", "the answer is larger than the limit; it cannot be compared with the outputSchema and was not kept", extra);
        continue;
      }
      const bad = await checkOutput(toolByName.get(c.tool), r);
      if (bad) answered(bad.state, bad.reason, extra);
      else answered("passed", "the server answered a success", extra);
    }
  } finally {
    host.close();
  }
  return { results, ...(stopped ? { stopped } : {}), restarts };
}

export interface AnonymousProbeOptions {
  /** The call to describe: the first allowed tool and its valid arguments. */
  record: { tool: string; args: Obj; expectAuth: boolean };
  guard: McpCallGuard;
  /** Connects with no credentials at all. `"auth-required"`: the server refused the connection itself. */
  connect: () => Promise<{ link: Link; close: () => Promise<void> } | "auth-required" | undefined>;
  callTimeoutMs: number;
  maxBytes?: number;
  secrets?: readonly string[];
  logDir?: string;
}

/**
 * One call without credentials, for an HTTP server run with credentials: once per server, through the guard, with no
 * header of ours. A refusal (HTTP 401 or 403, or a refused connection) passes. A success is a finding, not a failure:
 * the server may be public; with `--expect-auth` it fails. Any other error needs a person: no rule here can tell an
 * authentication error from an argument error.
 */
export async function runAnonymousProbe(o: AnonymousProbeOptions): Promise<{ result: CaseResult; finding: boolean }> {
  const { tool, args, expectAuth } = o.record;
  const base: CaseResult = { name: `${tool} · no-credentials`, stableId: `anon-${tool}`, tool, kind: "no-credentials", type: "Negative", state: "could-not-run", reason: "", observations: [], advice: [] };
  const done = (state: CaseState, reason: string, extra: Partial<CaseResult> = {}, finding = false) => ({ result: { ...base, state, reason, ...extra }, finding });
  const opened = await o.connect();
  if (opened === "auth-required") return done("passed", "the server refused the connection without credentials");
  if (!opened) return done("could-not-run", "could not connect without credentials");
  try {
    const call = await guardedToolCall(o.guard, opened.link, { tool, arguments: args }, {
      callTimeoutMs: o.callTimeoutMs,
      maxBytes: o.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      secrets: o.secrets ?? [],
      ...(o.logDir ? { log: (e) => appendCallLog(o.logDir as string, e) } : {}),
    });
    if (!call.sent) return done("not-sent", `the call guard refused it: ${call.decision.reason}`);
    const extra = { durationMs: call.entry.durationMs, request: call.entry.arguments };
    if (call.error) {
      const code = typeof call.error.code === "number" ? call.error.code : undefined;
      if (call.error.name === "StreamableHTTPError" && (code === 401 || code === 403)) return done("passed", `the server answered HTTP ${code} without credentials`, extra);
      if (call.error.name === "McpError" && code !== undefined) return done("needs-review", "an error without credentials: only a person can tell if it is an authentication error", extra);
      return done("could-not-run", "no answer without credentials", { ...extra, error: safeText(maskSecrets(call.error.message, o.secrets ?? []), 200) });
    }
    const r = (call.response ?? {}) as Obj;
    if (r["isError"] === true) return done("needs-review", "an error result without credentials: only a person can tell if it is an authentication error", extra);
    return expectAuth
      ? done("failed", "the call without credentials succeeded, and --expect-auth says it must not", extra, true)
      : done("needs-review", "finding: the call without credentials succeeded (the server may be public)", extra, true);
  } finally {
    await opened.close();
  }
}
