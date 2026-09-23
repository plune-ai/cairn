import type { CostLedger } from "../llm/cost.js";
import type { Telemetry } from "../telemetry/index.js";
import { CAPS, checkCaps } from "./capabilities.js";
import { postSystemOne, type HttpTarget } from "./client-http.js";
import { guarded } from "./guarded.js";
import { redact } from "./redact.js";
import { DeciderUnavailable, type Decider, type DeciderConfig, type Question } from "./types.js";

export { DeciderUnavailable, DECIDER_USES, DECIDER_PROVIDERS } from "./types.js";
export type { Answer, Decider, DeciderCaps, DeciderConfig, DeciderProvider, DeciderUse, Question } from "./types.js";
export { secretValues } from "./redact.js";

export interface DeciderDeps {
  /** Where decider tokens and cost land (spec §5.5: a `decider` row, only when the decider is on). */
  ledger: CostLedger;
  telemetry?: Pick<Telemetry, "recordDecision">;
  /** Scrubbed from every state before it leaves the process (redact.ts). */
  secrets?: readonly string[];
  /** One-line notices (where the data goes). Default: stderr. */
  warn?: (msg: string) => void;
  fetchFn?: typeof fetch;
}

export function httpTarget(cfg: DeciderConfig): HttpTarget {
  return { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) };
}

/** Where requests to `baseUrl` physically go — for the start-up notice and `cairn doctor`. */
export function dataDestination(baseUrl: string): { local: boolean; label: string } {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return { local: true, label: "this machine (localhost)" };
  if (host === "api.typesafe.ai") return { local: false, label: "TypeSafe cloud (api.typesafe.ai)" };
  return { local: false, label: `a remote server (${host})` };
}

let warnedRemote = false; // once per process, like the env deprecation notices

/** ~4 chars per token over the state and the questions — only when a server reports no usage. */
function estimateUsage(state: string, questions: Record<string, Question>): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Math.ceil((state.length + JSON.stringify(questions).length) / 4), outputTokens: 0 };
}

/**
 * The decision layer (ADR-0022) — or `undefined` when DECIDER is off, which is what keeps a run without
 * the flag byte-identical: every use point is gated on this value, and there is no other switch.
 */
export function makeDecider(cfg: DeciderConfig | undefined, deps: DeciderDeps): Decider | undefined {
  if (!cfg) return undefined;
  const caps = CAPS[cfg.provider];
  const target = httpTarget(cfg);
  const guard = guarded({ timeoutMs: cfg.timeoutMs, maxCalls: cfg.maxCalls });
  const dest = dataDestination(cfg.baseUrl);
  if (!dest.local && !warnedRemote) {
    warnedRemote = true;
    (deps.warn ?? ((m: string): void => void process.stderr.write(`${m}\n`)))(
      `[cairn] DECIDER=${cfg.provider} sends ARIA fragments, case texts and test errors to ${dest.label}. ` +
        "For an app behind a login, prefer DECIDER=laya (runs locally) — see docs/decider.md.",
    );
  }
  return {
    provider: cfg.provider,
    model: cfg.model,
    caps,
    uses: new Set(cfg.uses),
    minConfidence: cfg.minConfidence,
    async decide(use, rawState, questions) {
      const state = redact(rawState, deps.secrets ?? []);
      const trace = { use, provider: cfg.provider, startTime: new Date(), state, questions, minConfidence: cfg.minConfidence };
      try {
        checkCaps(caps, state, questions);
        const res = await guard.run((signal) => postSystemOne(target, state, questions, signal, deps.fetchFn));
        deps.ledger.record("decider", cfg.model, res.usage ?? estimateUsage(state, questions), caps.price);
        deps.telemetry?.recordDecision?.({
          ...trace,
          model: res.model ?? cfg.model,
          endTime: new Date(),
          answers: res.answers,
          fallback: false,
        });
        return res.answers;
      } catch (e) {
        const err = e instanceof DeciderUnavailable ? e : new DeciderUnavailable(e instanceof Error ? e.message : String(e));
        deps.telemetry?.recordDecision?.({ ...trace, model: cfg.model, endTime: new Date(), fallback: true, reason: err.message });
        throw err;
      }
    },
  };
}
