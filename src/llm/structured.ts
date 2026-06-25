import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { ZodType } from "zod";
import { extractUsage, type TokenUsage } from "./cost.js";

/**
 * Structured-call seam: (schema, messages) → typed result.
 * Decouples domain logic (design/analyze) from the concrete model — a fake is injected in tests.
 */
export type StructuredInvoke = <T>(schema: ZodType<T>, messages: BaseMessageLike[]) => Promise<T>;

/**
 * How LangChain should obtain structured output. `jsonSchema` (the ChatOpenAI default) sends
 * `response_format: json_schema`, which Groq rejects for most models (e.g. llama-3.3-70b-versatile);
 * `functionCalling` uses tool-calling instead, which those models DO support (L1-02 fix). Pick it per
 * provider via {@link structuredMethodFor}; `undefined` leaves the LangChain default untouched.
 */
export type StructuredMethod = "functionCalling" | "jsonMode" | "jsonSchema";

/** Real implementation on top of LangChain `withStructuredOutput`. */
export function structuredInvoker(model: BaseChatModel, method?: StructuredMethod): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    const structured = model.withStructuredOutput(schema, method ? { method } : undefined);
    return (await structured.invoke(messages)) as T;
  };
}

/**
 * Like {@link structuredInvoker}, but captures token usage off the raw LangChain response
 * (via `withStructuredOutput(..., { includeRaw: true })`) and reports it to `onUsage` (L1-01).
 * Node logic is unchanged — callers still receive the parsed result. Metering never throws.
 */
export function meteredInvoker(
  model: BaseChatModel,
  onUsage: (usage: TokenUsage, model: string) => void,
  modelId: string,
  method?: StructuredMethod,
  config?: Record<string, unknown>,
): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    const structured = model.withStructuredOutput(schema, { includeRaw: true, ...(method ? { method } : {}) });
    const res = (await structured.invoke(messages, config)) as { raw: unknown; parsed: T };
    try {
      onUsage(extractUsage(res.raw), modelId);
    } catch {
      // metering must never break the underlying call
    }
    return res.parsed;
  };
}

/** Transient provider errors worth retrying (rate limit / overload / 5xx / timeout). */
const TRANSIENT =
  /\b429\b|rate.?limit|overloaded|temporarily|timeout|ETIMEDOUT|ECONNRESET|\b50\d\b|service unavailable/i;

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Retry wrapper (Sprint 6 robustness): retries the call on TRANSIENT errors (429/5xx/overloaded)
 * with exponential backoff. Non-transient errors (schema validation, 4xx) are thrown immediately.
 */
export function retryInvoke(inner: StructuredInvoke, opts: RetryOptions = {}): StructuredInvoke {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await inner(schema, messages);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === retries || !TRANSIENT.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      }
    }
    throw lastErr;
  };
}

/**
 * Default per-step LLM timeout (#110). Anthropic finishes a step in ~90s; OpenRouter `deepseek-r1`
 * (reasoner) / `deepseek-chat` (codegen) can hang for minutes, overrunning interactive/MCP timeouts.
 * 4 min lets a healthy Anthropic step through while cutting a pathological provider hang short with an
 * actionable error. Overridable via `STEP_TIMEOUT_MS`; `0` disables the timeout entirely.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 240_000;

export interface TimeoutOptions {
  /** Wall-clock cap per step (ms). `0`/negative/undefined → no timeout (wrapper returns `inner` as-is). */
  timeoutMs?: number;
  /** Context for the error message, e.g. `role 'reasoner', model 'deepseek/deepseek-r1'`. */
  label?: string;
}

/**
 * Per-step timeout (#110): bounds the wall-clock of one structured call (incl. its retries when wrapped
 * OUTSIDE {@link retryInvoke}) and, on overrun, throws ONE actionable error instead of hanging forever —
 * critical for the MCP server, where the caller can't see progress. The losing inner call is left to
 * settle in the background (its rejection is swallowed); we don't cancel the HTTP request, we just stop
 * waiting. The actionable message points at the latency-safe escapes (a faster `--routing`/Anthropic),
 * deliberately NOT Groq `fast`, which 400s on large codegen (`groq-fast-json-schema-bug`).
 */
export function timeoutInvoke(inner: StructuredInvoke, opts: TimeoutOptions = {}): StructuredInvoke {
  const timeoutMs = opts.timeoutMs ?? 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return inner; // disabled → no overhead, no behavior change
  const where = opts.label ? ` (${opts.label})` : "";
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    const innerP = inner(schema, messages);
    innerP.catch(() => undefined); // a losing race must not surface as an unhandledRejection
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `LLM step timed out after ${timeoutMs}ms${where} — the provider is too slow for this step. ` +
              `Try a faster routing (e.g. --routing volume-fast) or the Anthropic profile ` +
              `(LLM_PROFILE=anthropic), or raise STEP_TIMEOUT_MS.`,
          ),
        );
      }, timeoutMs);
      // Never let a pending timer keep the process alive (e.g. after the call settles late).
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([innerP, timeoutP]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** Cost-guardrail (Sprint 6): shared LLM-call counter per run — a safeguard against runaway cost. */
export class CallBudget {
  private n = 0;
  constructor(private readonly cap: number) {}
  charge(): void {
    this.n += 1;
    if (this.n > this.cap) {
      throw new Error(
        `LLM-call budget limit reached (${this.cap} calls) — cost-guardrail. Increase maxLlmCalls or check for a loop.`,
      );
    }
  }
  /** Calls charged so far (counts the over-cap call that threw, too). */
  get spent(): number {
    return this.n;
  }
  /** The configured cap — surfaced so a run can show used/remaining (L1-04, Box 3). */
  get max(): number {
    return this.cap;
  }
  /** Calls left before the cap trips (never negative). */
  get remaining(): number {
    return Math.max(0, this.cap - this.n);
  }
}

/**
 * Cost-guardrail wrapper: counts the call against the shared CallBudget (throws when exceeded).
 * `onCharge` (L1-04, Box 3) fires after each *successful* charge with (used, max) — never for the
 * over-cap call that throws — so a run can warn as it nears the budget.
 */
export function cappedInvoke(
  inner: StructuredInvoke,
  budget: CallBudget,
  onCharge?: (used: number, max: number) => void,
): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    budget.charge();
    onCharge?.(budget.spent, budget.max);
    return inner(schema, messages);
  };
}
