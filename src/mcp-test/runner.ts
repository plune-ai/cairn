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
import { describeArguments, guardedToolCall, appendCallLog, type CallError, type ToolRpc } from "./call.js";
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
  /** `psycho` or `hacker` for an adversarial case: the guard treats those as mutating. */
  style?: string;
  /** Whether the payload was handled safely is for a person to say: such a case never passes by itself. */
  humanOracle?: boolean;
  expect:
    | { outcome: "success"; outputSchema?: boolean }
    | { outcome: "rejected"; forms?: unknown }
    | { outcome: "robust"; failedWhen: readonly string[] };
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
}

/** A connection the runner can ask: the current one, and how to start the server again (stdio only). */
export interface Link {
  request: ToolRpc["request"];
  transport: "stdio" | "streamable-http";
}

export interface RunnerOptions {
  guard: McpCallGuard;
  /** The tools as listed when the user looked: their outputSchemas decide what a result must hold. */
  tools: readonly McpToolEntry[];
  link: Link;
  /** Starts a stdio server again after it died; returns the new link, or undefined when it cannot. */
  restart?: () => Promise<Link | undefined>;
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
  | { kind: "result"; result: Obj; bytes: number; truncated: boolean }
  | { kind: "rpc-error"; code: number; message: string }
  | { kind: "anomaly"; anomaly: Anomaly; message: string }
  | { kind: "unjudgeable"; message: string };

function classify(transport: Link["transport"], outcome: string, error: CallError | undefined, response: unknown, max: number): Answer {
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
    bytes = JSON.stringify(response).length;
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

function isErrorResult(r: Obj): boolean {
  return r["isError"] === true;
}

export async function runCases(cases: readonly RunnableCase[], o: RunnerOptions): Promise<RunResult> {
  const secrets = o.secrets ?? [];
  const max = o.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const host = new OracleHost();
  const toolByName = new Map(o.tools.map((t) => [t.name, t]));
  const results: CaseResult[] = [];
  const observed = new Set<string>();
  let link = o.link;
  let alive = true; // an answer (or the start of this connection) was seen since the last silence
  let silent = 0;
  let crashes = 0;
  let restarts = 0;
  let stopped: string | undefined;

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
      ...extra,
    });
  };

  /** The output check of a successful result: undefined when it holds, else the verdict. */
  const checkOutput = async (tool: McpToolEntry | undefined, result: Obj): Promise<{ state: CaseState; reason: string } | undefined> => {
    const schema = tool?.outputSchema;
    if (!schema) return undefined;
    if (result["structuredContent"] === undefined) return { state: "failed", reason: "the tool declares an outputSchema but the result has no structuredContent" };
    const problem = scanSchema(schema);
    if (problem) return { state: "needs-review", reason: `the outputSchema could not be checked (${problem.keyword}: ${safeText(problem.message, 120)})` };
    try {
      const valid = host.oracle(schema).check(result["structuredContent"]).valid;
      return valid ? undefined : { state: "failed", reason: "structuredContent does not match the tool's outputSchema" };
    } catch (e) {
      return { state: "needs-review", reason: `the outputSchema could not be checked (${safeText((e as Error).message, 120)})` };
    }
  };

  try {
    for (const c of cases) {
      if (stopped || o.signal?.aborted) {
        finish(c, "could-not-run", stopped ?? "interrupted");
        continue;
      }
      // A tool that changed since the user looked is refused by the guard: ask it to compare before the first call.
      if (!observed.has(c.tool) && o.relist) {
        observed.add(c.tool);
        try {
          o.guard.observe(await o.relist());
        } catch {
          /* the guard keeps the list it was given */
        }
      }
      const call = await guardedToolCall(o.guard, link, { tool: c.tool, ...(c.style ? { style: c.style } : {}), arguments: c.args }, {
        callTimeoutMs: o.callTimeoutMs,
        secrets,
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.logDir ? { log: (e) => appendCallLog(o.logDir as string, e) } : {}),
      });
      if (!call.sent) {
        finish(c, "not-sent", `the call guard refused it: ${call.decision.reason}`);
        continue;
      }
      const answer = classify(link.transport, call.entry.result, call.error, call.response, max);
      const base: Partial<CaseResult> = { durationMs: call.entry.durationMs, request: call.entry.arguments };

      if (answer.kind === "anomaly") {
        const aliveBefore = alive;
        alive = false;
        silent += 1;
        const failedWhen = c.expect.outcome === "robust" ? c.expect.failedWhen : [];
        // The case is at fault only if the server was answering just before it (a process exit counts for every case).
        const atFault = aliveBefore && (answer.anomaly === "process-exit" || failedWhen.includes(answer.anomaly));
        finish(c, atFault ? "failed" : "could-not-run", atFault ? `${answer.message} (the server was answering before this case)` : `${answer.message}${aliveBefore ? "" : "; the server was not answering before this case"}`, { ...base, error: safeText(maskSecrets(answer.message, secrets), 200) });
        if (answer.anomaly === "process-exit") {
          crashes += 1;
          if (crashes >= 2) stopped = "the server process exited twice; the run was stopped";
          else if (link.transport === "stdio" && o.restart) {
            const next = await o.restart();
            if (next) {
              link = next;
              restarts += 1;
              alive = true;
              silent = 0;
              observed.clear();
            } else stopped = "the server process could not be started again; the run was stopped";
          } else stopped = "the server connection is gone; the run was stopped";
        } else if (silent >= MAX_SILENT_IN_A_ROW) stopped = `${MAX_SILENT_IN_A_ROW} cases in a row got no answer; the run was stopped`;
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
        const advice = findAdvice(text, secrets);
        const extra = { response: text, advice };
        const e = c.expect;
        if (e.outcome === "rejected") answered("passed", `refused with a JSON-RPC error (${answer.code})`, extra);
        else if (e.outcome === "robust") answered(c.humanOracle ? "needs-review" : "passed", c.humanOracle ? `refused with a JSON-RPC error (${answer.code}); whether the payload was handled safely needs a person` : `refused with a JSON-RPC error (${answer.code})`, extra);
        else answered("failed", `the server answered a JSON-RPC error (${answer.code}) to a value its schema allows`, extra);
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
        if (isErrorResult(r)) extra = { ...extra, advice: findAdvice(text, secrets) };
      }
      const e = c.expect;
      if (e.outcome === "rejected") {
        if (isErrorResult(r)) answered("passed", "refused with an error result (isError)", extra);
        else answered("failed", "the server accepted a value that violates its schema", extra);
        continue;
      }
      if (e.outcome === "robust") {
        if (answer.truncated) answered("needs-review", "the answer is larger than the limit and was not kept", extra);
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
