/**
 * Per-role cost + token accounting (L1-01, ADR-0011). Pure — no SDK, no network.
 *
 * `CallBudget` (structured.ts) counts CALLS as a guardrail; this is its sibling that
 * counts tokens and prices them per role. Capture happens in `meteredInvoker`.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Default price table (USD per 1M tokens). Anthropic prices are authoritative
 * (claude-api skill, 2026-06). OpenRouter prices are APPROXIMATE and move
 * (ADR-0002) — any model absent here yields a null (unknown) cost; tokens are
 * still counted. Override by passing a table to `CostLedger`.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5 },
  // OpenRouter — approximate, movable (ADR-0002, self-hosted Langfuse needs custom pricing).
  "deepseek/deepseek-chat": { inputPer1M: 0.28, outputPer1M: 0.88 },
  "deepseek/deepseek-r1": { inputPer1M: 0.55, outputPer1M: 2.19 },
  "qwen/qwen-2.5-72b-instruct": { inputPer1M: 0.35, outputPer1M: 0.4 },
  "qwen/qwen-2-vl-72b-instruct": { inputPer1M: 0.4, outputPer1M: 0.4 },
};

export function priceFor(
  model: string,
  table: Record<string, ModelPrice> = DEFAULT_PRICING,
): ModelPrice | undefined {
  return table[model];
}

/** Minimal structural view of a LangChain response carrying token usage. */
interface UsageCarrier {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
  response_metadata?: {
    usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    tokenUsage?: { promptTokens?: number; completionTokens?: number };
  };
}

/**
 * Read token usage off a LangChain message. Prefers `usage_metadata` (normalized by
 * LangChain across providers), then `response_metadata.usage` (OpenAI/OpenRouter), then
 * `tokenUsage`. Never throws — missing usage yields zeros (graceful per ADR-0002).
 */
export function extractUsage(raw: unknown): TokenUsage {
  const m = (raw ?? {}) as UsageCarrier;
  const um = m.usage_metadata;
  if (um && (um.input_tokens !== undefined || um.output_tokens !== undefined)) {
    return { inputTokens: um.input_tokens ?? 0, outputTokens: um.output_tokens ?? 0 };
  }
  const u = m.response_metadata?.usage;
  if (u) {
    return {
      inputTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
      outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
    };
  }
  const t = m.response_metadata?.tokenUsage;
  if (t) return { inputTokens: t.promptTokens ?? 0, outputTokens: t.completionTokens ?? 0 };
  return { inputTokens: 0, outputTokens: 0 };
}

export interface RoleCost {
  role: string;
  models: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** null when any contributing model has no configured price (tokens still reported). */
  costUsd: number | null;
}

export interface CostReport {
  perRole: RoleCost[];
  totalTokens: number;
  /** null when any role's cost is unknown. */
  totalCostUsd: number | null;
}

interface Row {
  models: Set<string>;
  calls: number;
  in: number;
  out: number;
  cost: number;
  costKnown: boolean;
}

const ROLE_ORDER = ["worker", "reasoner", "judge"];

/** Accumulates usage per role and prices it. Sibling to CallBudget; one per run. */
export class CostLedger {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly pricing: Record<string, ModelPrice> = DEFAULT_PRICING) {}

  record(role: string, model: string, usage: TokenUsage): void {
    const row = this.rows.get(role) ?? { models: new Set<string>(), calls: 0, in: 0, out: 0, cost: 0, costKnown: true };
    row.calls += 1;
    row.in += usage.inputTokens;
    row.out += usage.outputTokens;
    row.models.add(model);
    const p = this.pricing[model];
    if (p) row.cost += (usage.inputTokens / 1e6) * p.inputPer1M + (usage.outputTokens / 1e6) * p.outputPer1M;
    else row.costKnown = false;
    this.rows.set(role, row);
  }

  report(): CostReport {
    const rank = (r: string): number => {
      const i = ROLE_ORDER.indexOf(r);
      return i === -1 ? ROLE_ORDER.length : i;
    };
    const roles = [...this.rows.keys()].sort((a, b) => rank(a) - rank(b));
    const perRole: RoleCost[] = roles.map((role) => {
      const r = this.rows.get(role) as Row;
      return {
        role,
        models: [...r.models],
        calls: r.calls,
        inputTokens: r.in,
        outputTokens: r.out,
        totalTokens: r.in + r.out,
        costUsd: r.costKnown ? Number(r.cost.toFixed(6)) : null,
      };
    });
    const totalTokens = perRole.reduce((s, r) => s + r.totalTokens, 0);
    const anyUnknown = perRole.some((r) => r.costUsd === null);
    const totalCostUsd = anyUnknown
      ? null
      : Number(perRole.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(6));
    return { perRole, totalTokens, totalCostUsd };
  }
}
