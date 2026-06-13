import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { ZodType } from "zod";
import { extractUsage, type TokenUsage } from "./cost.js";

/**
 * Structured-call seam: (schema, messages) → typed result.
 * Decouples domain logic (design/analyze) from the concrete model — a fake is injected in tests.
 */
export type StructuredInvoke = <T>(schema: ZodType<T>, messages: BaseMessageLike[]) => Promise<T>;

/** Real implementation on top of LangChain `withStructuredOutput`. */
export function structuredInvoker(model: BaseChatModel): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    const structured = model.withStructuredOutput(schema);
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
): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    const structured = model.withStructuredOutput(schema, { includeRaw: true });
    const res = (await structured.invoke(messages)) as { raw: unknown; parsed: T };
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

/** Cost-guardrail (Sprint 6): shared LLM-call counter per run — a safeguard against runaway cost. */
export class CallBudget {
  private n = 0;
  constructor(private readonly max: number) {}
  charge(): void {
    this.n += 1;
    if (this.n > this.max) {
      throw new Error(
        `LLM-call limit per run exceeded (${this.max}) — cost-guardrail. Increase maxLlmCalls or check the loop.`,
      );
    }
  }
  get spent(): number {
    return this.n;
  }
}

/** Cost-guardrail wrapper: counts the call against the shared CallBudget (throws when exceeded). */
export function cappedInvoke(inner: StructuredInvoke, budget: CallBudget): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    budget.charge();
    return inner(schema, messages);
  };
}
