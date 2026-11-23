import type { CallbackHandler } from "@langfuse/langchain";
import type { LangfuseClient } from "@langfuse/client";
import type { AppConfig } from "../config/index.js";

/**
 * Bot telemetry (ADR-0006). Langfuse v5 — OTel-first:
 * `LangfuseSpanProcessor` is registered in `NodeSDK` and exports spans to the self-hosted instance;
 * `CallbackHandler` only emits OTel spans (its constructor does NOT take keys);
 * `LangfuseClient` — for scores/datasets/prompts (SDK-side judges, ADR-0006).
 *
 * 0.3.3: `@langfuse/*` + `@opentelemetry/*` are OPTIONAL peer dependencies. They are NOT in the default
 * install (they carry the only `npm audit` moderate and most of the footprint), so they are imported
 * LAZILY and only when Langfuse is actually configured. The type-only imports above are erased at
 * compile time, so nothing here pulls those packages at runtime unless the enabled path runs.
 */
/** ADR-0022: one decider call, as reported to tracing. */
export interface DecisionTrace {
  use: string;
  provider: string;
  model: string;
  startTime: Date;
  endTime: Date;
  /** The state as sent (already scrubbed of secrets). */
  state: string;
  questions: unknown;
  answers?: unknown;
  /** true when the call failed and the use point took its old path. */
  fallback: boolean;
  reason?: string;
  minConfidence: number;
}

/** What the root trace carries besides its name: metadata, and the run's input (shown as the trace Input). */
export interface TraceAttrs {
  metadata: Record<string, unknown>;
  input: unknown;
}

/**
 * The run result as the trace Output: as is, but without the page screenshot (`study.screenshotB64`, base64 —
 * it would bloat every trace; the screenshot stays in the run folder).
 */
export function traceOutput(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("study" in result)) return result;
  const study = (result as { study: unknown }).study;
  if (typeof study !== "object" || study === null) return result;
  const rest = { ...(study as Record<string, unknown>) };
  delete rest["screenshotB64"];
  return { ...result, study: rest };
}

export interface Telemetry {
  enabled: boolean;
  callbackHandler?: CallbackHandler;
  client?: LangfuseClient;
  shutdown: () => Promise<void>;
  /**
   * ADR-0022: a decider call as a span nested under the active stage, plus a `decider.<use>.confidence`
   * score (the lowest confidence among its answers). Absent when tracing is off.
   */
  recordDecision?: (d: DecisionTrace) => void;
  /** ADR-0022 shadow mode: a numeric score on the active trace (`decider.<use>.agreement`). Absent when tracing is off. */
  recordScore?: (name: string, value: number) => void;
  /**
   * Wraps `fn` in a root Langfuse span so that all nested LangChain callback-handler
   * generations are collected under ONE trace (rather than N separate traces). When
   * telemetry is disabled, `fn` is called directly (no-op path). (Task 2, ADR-0012)
   */
  runInTrace: <T>(name: string, attrs: TraceAttrs, fn: () => Promise<T>) => Promise<T>;
  /**
   * The web address of the active run trace, for `report.json` — call it inside `runInTrace`. Resolves to
   * `undefined`, after ONE `warn` line, when no address fit for a report can be built. Absent when tracing is off.
   */
  traceUrl?: (warn: (line: string) => void) => Promise<string | undefined>;
}

/** The longest trace link a report carries; readers of the report keep no longer one. */
const TRACE_URL_MAX = 2048;

/**
 * A trace address as a report may carry it, or `undefined`: https only, a host, no user name or password, no
 * query or fragment, no space or control character, at most `TRACE_URL_MAX` characters, and none of `keys`
 * anywhere in it, percent-encoded or in another case included. A doubled
 * slash in the path (a base URL written with a trailing slash) is folded.
 */
export function reportableTraceUrl(raw: string, keys: readonly (string | undefined)[] = []): string | undefined {
  if (!URL.canParse(raw)) return undefined;
  const parsed = new URL(raw);
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  const url = parsed.href;
  if (parsed.protocol !== "https:" || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") return undefined;
  if (url.length > TRACE_URL_MAX || /[\s\p{Cc}\p{Cf}]/u.test(url)) return undefined;
  // The SDK's address has neither; one in the base URL is where a token would ride along.
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  // Keys are looked for in the decoded, lower-cased address, so `%2D` for `-` or another case hides none.
  let plain: string;
  try {
    plain = decodeURIComponent(url).toLowerCase();
  } catch {
    return undefined;
  }
  if (keys.some((k) => k && plain.includes(k.toLowerCase()))) return undefined;
  return url;
}

/**
 * The run trace's web address through the tracing SDK's own `lookup` (it knows the base URL and asks the server
 * for the project the keys belong to), bounded by `timeoutMs` so a silent server cannot hold the report back.
 * No address, or one `reportableTraceUrl` refuses, costs only the link: `undefined`, and one `warn` line that
 * shows neither the address nor the lookup's error (either can carry a credential).
 */
export async function resolveTraceUrl(deps: {
  traceId: string | undefined;
  lookup: (traceId: string) => Promise<string>;
  keys?: readonly (string | undefined)[];
  warn: (line: string) => void;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const skip = (why: string): undefined => {
    deps.warn(`trace link — not written to the report: ${why}`);
    return undefined;
  };
  if (!deps.traceId) return skip("the run has no active trace");
  let timer: NodeJS.Timeout | undefined;
  let raw: string;
  try {
    raw = await Promise.race([
      deps.lookup(deps.traceId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), deps.timeoutMs ?? 5000);
      }),
    ]);
  } catch {
    return skip("the tracing server did not give the trace's address (check LANGFUSE_BASE_URL and the keys)");
  } finally {
    clearTimeout(timer);
  }
  return (
    reportableTraceUrl(raw, deps.keys) ??
    skip("the trace's address must be https, with no user name, password, key, query or fragment in it (check LANGFUSE_BASE_URL)")
  );
}

/** The offline / not-configured / packages-absent result: a no-op so the bot runs without tracing. */
function noopTelemetry(): Telemetry {
  return { enabled: false, shutdown: async () => {}, runInTrace: (_n, _m, fn) => fn() };
}

/**
 * Telemetry bootstrap. Returns a no-op (so the bot works offline — ADR-0004/0006) when Langfuse is
 * disabled (no keys) OR when the optional tracing packages are not installed. The enabled path is
 * verified by the live Spike S5. Async because the tracing packages are lazy-`import()`ed.
 */
export async function initTelemetry(cfg: AppConfig): Promise<Telemetry> {
  if (!cfg.langfuse.enabled) return noopTelemetry();

  const { baseUrl, publicKey, secretKey } = cfg.langfuse;

  // Capability check: load the OPTIONAL tracing packages on demand. If any is absent, tracing
  // silently no-ops (with one hint) instead of crashing a run that is otherwise fully functional.
  let otel: typeof import("@opentelemetry/sdk-node");
  let lfOtel: typeof import("@langfuse/otel");
  let lfLangchain: typeof import("@langfuse/langchain");
  let lfClient: typeof import("@langfuse/client");
  let lfTracing: typeof import("@langfuse/tracing");
  try {
    otel = await import("@opentelemetry/sdk-node");
    lfOtel = await import("@langfuse/otel");
    lfLangchain = await import("@langfuse/langchain");
    lfClient = await import("@langfuse/client");
    lfTracing = await import("@langfuse/tracing");
  } catch {
    process.stderr.write(
      "[cairn] Langfuse is configured (LANGFUSE_* set) but the optional tracing packages are not " +
        "installed — continuing without tracing.\n" +
        "  Enable tracing:  npm install @langfuse/client @langfuse/langchain @langfuse/otel " +
        "@langfuse/tracing @opentelemetry/api @opentelemetry/sdk-node\n",
    );
    return noopTelemetry();
  }

  const spanProcessor = new lfOtel.LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
  const sdk = new otel.NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();

  const client = new lfClient.LangfuseClient({ publicKey, secretKey, baseUrl });
  const callbackHandler = new lfLangchain.CallbackHandler();

  const shutdown = async (): Promise<void> => {
    await client.score.flush().catch(() => undefined); // flush remaining scores (B1)
    await spanProcessor.forceFlush();
    await sdk.shutdown();
  };

  /**
   * Wraps `fn` in a root Langfuse span via `startActiveObservation`, so that all nested
   * LangChain CallbackHandler generations attach to ONE trace instead of N separate traces.
   * The span name becomes the Langfuse trace name. `metadata` is stored as span metadata.
   * With `@langfuse/*` v6 the trace takes its Input and Output from the root observation (there is no
   * trace-level setter), so the root span carries the run's input and its result as output.
   */
  const runInTrace = <T>(name: string, attrs: TraceAttrs, fn: () => Promise<T>): Promise<T> =>
    lfTracing.startActiveObservation(name, async (span) => {
      span.update({ metadata: attrs.metadata, input: attrs.input });
      const result = await fn();
      span.update({ output: traceOutput(result) });
      return result;
    }) as Promise<T>;

  const recordDecision = (d: DecisionTrace): void => {
    try {
      const span = lfTracing.startObservation(
        `decider.${d.use}`,
        {
          input: { state: d.state.slice(0, 2000), questions: d.questions },
          output: d.answers,
          metadata: {
            provider: d.provider,
            model: d.model,
            latencyMs: d.endTime.getTime() - d.startTime.getTime(),
            fallback: d.fallback,
            reason: d.reason,
            minConfidence: d.minConfidence,
          },
          ...(d.fallback ? { level: "WARNING" as const, statusMessage: d.reason } : {}),
        },
        { startTime: d.startTime },
      );
      span.end(d.endTime);
      const confidences = Object.values((d.answers ?? {}) as Record<string, { confidence?: unknown }>)
        .map((a) => a.confidence)
        .filter((c): c is number => typeof c === "number");
      if (confidences.length > 0) {
        client.score.create({
          traceId: span.traceId,
          observationId: span.id,
          name: `decider.${d.use}.confidence`,
          value: Math.min(...confidences),
          dataType: "NUMERIC",
        });
      }
    } catch {
      // tracing is best-effort — it must never touch the run
    }
  };

  const recordScore = (name: string, value: number): void => {
    try {
      const traceId = lfTracing.getActiveTraceId();
      if (traceId) client.score.create({ traceId, name, value, dataType: "NUMERIC" });
    } catch {
      // tracing is best-effort — it must never touch the run
    }
  };

  const traceUrl = (warn: (line: string) => void): Promise<string | undefined> =>
    resolveTraceUrl({
      traceId: lfTracing.getActiveTraceId(),
      lookup: (traceId) => client.getTraceUrl(traceId),
      keys: [publicKey, secretKey],
      warn,
    });

  return { enabled: true, callbackHandler, client, shutdown, runInTrace, recordDecision, recordScore, traceUrl };
}
