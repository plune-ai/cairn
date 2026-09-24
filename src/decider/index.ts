import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CostLedger } from "../llm/cost.js";
import type { DecisionTrace, Telemetry } from "../telemetry/index.js";
import { createEnvReader } from "../config/env.js";
import { parseDeciderConfig, TYPESAFE_HOST } from "../config/index.js";
import { CAPS, checkCaps } from "./capabilities.js";
import { postSystemOne, type HttpTarget } from "./client-http.js";
import { guarded } from "./guarded.js";
import { redact, redactQuestion } from "./redact.js";
import type { TriageResult } from "./uses/repair-triage.js";
import {
  DeciderUnavailable,
  type Decider,
  type DeciderConfig,
  type DeciderSummary,
  type Question,
  type ShadowEntry,
  type ShadowLog,
} from "./types.js";

export { DeciderUnavailable, DECIDER_USES, DECIDER_PROVIDERS } from "./types.js";
export type {
  Answer,
  Decider,
  DeciderCaps,
  DeciderConfig,
  DeciderProvider,
  DeciderSummary,
  DeciderUse,
  Question,
  ShadowEntry,
  ShadowLog,
} from "./types.js";
export { secretValues } from "./redact.js";

export interface DeciderDeps {
  /**
   * Where decider tokens and cost land (spec §5.5: a `decider` row, only when the decider is on). In shadow
   * mode the decider meters into a private ledger instead, so the run's `report.json` cost is untouched.
   */
  ledger: CostLedger;
  telemetry?: Pick<Telemetry, "recordDecision" | "recordScore">;
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
  // A dotted quad only: `127.evil.com` is a DNS name like any other.
  if (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return { local: true, label: "this machine (localhost)" };
  if (TYPESAFE_HOST.test(host)) return { local: false, label: `TypeSafe cloud (${host})` };
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
  const ledger = cfg.shadow ? new CostLedger() : deps.ledger;
  let calls = 0;
  const fallbacks: DeciderSummary["fallbacks"] = [];
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
    ...(cfg.shadow ? { shadow: shadowLog(deps.telemetry) } : {}),
    summary: () => ({
      provider: cfg.provider,
      model: cfg.model,
      calls,
      fallbacks: [...fallbacks],
      ...(cfg.shadow ? { cost: ledger.report() } : {}),
    }),
    async decide(use, rawState, rawQuestions) {
      calls += 1;
      // state/questions are filled only once scrubbed: a trace never carries the raw text.
      const trace = { use, provider: cfg.provider, startTime: new Date(), state: "", questions: {} as unknown, minConfidence: cfg.minConfidence };
      const record = (t: DecisionTrace): void => {
        try {
          deps.telemetry?.recordDecision?.(t);
        } catch {
          // tracing never touches the answer
        }
      };
      try {
        // Inside the try: a scrubbing failure is a fallback like any other.
        const secrets = deps.secrets ?? [];
        const state = redact(rawState, secrets);
        const questions = (
          secrets.length
            ? Object.fromEntries(Object.entries<Question>(rawQuestions).map(([k, q]) => [k, redactQuestion(q, secrets)]))
            : rawQuestions
        ) as typeof rawQuestions;
        Object.assign(trace, { state, questions });
        checkCaps(caps, state, questions);
        const res = await guard.run((signal) => postSystemOne(target, state, questions, signal, deps.fetchFn));
        ledger.record("decider", cfg.model, res.usage ?? estimateUsage(state, questions), caps.price);
        record({ ...trace, model: res.model ?? cfg.model, endTime: new Date(), answers: res.answers, fallback: false });
        return res.answers;
      } catch (e) {
        const err = e instanceof DeciderUnavailable ? e : new DeciderUnavailable(e instanceof Error ? e.message : String(e));
        fallbacks.push({ use, reason: err.message });
        record({ ...trace, model: cfg.model, endTime: new Date(), fallback: true, reason: err.message });
        throw err;
      }
    },
  };
}

function shadowLog(telemetry?: Pick<Telemetry, "recordScore">): ShadowLog {
  const entries: ShadowEntry[] = [];
  return {
    entries,
    record(e) {
      entries.push(e);
      if (e.agreement !== undefined) telemetry?.recordScore?.(`decider.${e.use}.agreement`, e.agreement);
    },
  };
}

/**
 * The report keys an opted-in run adds — `{}` otherwise, so a run without the flag writes the very same
 * files. Shadow mode adds nothing here either: its only artifact is decider-shadow.json.
 */
export function deciderReportKeys(
  d: Decider | undefined,
  notRepaired?: TriageResult[],
): { decider?: DeciderSummary; notRepaired?: TriageResult[] } {
  return {
    ...(d && !d.shadow ? { decider: d.summary() } : {}),
    ...(notRepaired?.length ? { notRepaired } : {}),
  };
}

/**
 * Shadow mode's only artifact (spec §7): `runs/<id>/decider-shadow.json`. A no-op for an active decider or
 * none, so every other file of the run stays what it would have been without the flag.
 */
export async function writeShadowFile(runDir: string, decider: Decider | undefined, file = "decider-shadow.json"): Promise<void> {
  if (!decider?.shadow) return;
  const { provider, model, calls, fallbacks, cost } = decider.summary();
  const payload = { provider, model, minConfidence: decider.minConfidence, calls, fallbacks, cost, entries: decider.shadow.entries };
  await writeFile(join(runDir, file), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const DOCTOR_QUESTION: Question = {
  type: "noul",
  instructions: "Is this text a connectivity check?",
  criteria: { true: "The text says it is a connectivity check", false: "The text is about something else" },
};

/**
 * `cairn doctor` (spec §4): the provider, where the data goes, and ONE real `noul` call with its latency.
 * `[]` when DECIDER is off. Never throws — a misconfiguration or a dead server is a finding, not a crash.
 */
export async function deciderDoctorReport(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const head = ["", "Cairn decision layer (DECIDER — ADR-0022)"];
  let cfg: DeciderConfig | undefined;
  try {
    cfg = parseDeciderConfig(createEnvReader(env, () => undefined));
  } catch (e) {
    return [...head, `  ✗ ${(e as Error).message}`];
  }
  if (!cfg) return [];
  const dest = dataDestination(cfg.baseUrl);
  const lines = [
    ...head,
    `  Provider: ${cfg.provider} · model: ${cfg.model}`,
    `  Base URL: ${cfg.baseUrl}`,
    `  Data goes to: ${dest.label}${dest.local ? "" : " — ARIA fragments, case texts and test errors leave this machine"}`,
    `  Uses: ${cfg.uses.join(", ")} · min confidence ${cfg.minConfidence} · timeout ${cfg.timeoutMs} ms · ≤ ${cfg.maxCalls} decisions/run`,
    ...(cfg.shadow ? ["  Mode: shadow mode — answers are recorded, never acted on (runs/<id>/decider-shadow.json)"] : []),
  ];
  const target = httpTarget(cfg);
  const t0 = Date.now();
  try {
    const r = await guarded({ timeoutMs: cfg.timeoutMs, maxCalls: 1 }).run((signal) =>
      postSystemOne(target, "Cairn doctor connectivity check.", { q: DOCTOR_QUESTION }, signal, fetchFn),
    );
    lines.push(`  ✓ Test call (noul): ${Date.now() - t0} ms · answered by ${r.model ?? cfg.model}`);
  } catch (e) {
    lines.push(`  ✗ Test call failed: ${(e as Error).message}`);
  }
  return lines;
}
