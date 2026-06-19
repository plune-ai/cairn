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
export interface Telemetry {
  enabled: boolean;
  callbackHandler?: CallbackHandler;
  client?: LangfuseClient;
  shutdown: () => Promise<void>;
  /**
   * Wraps `fn` in a root Langfuse span so that all nested LangChain callback-handler
   * generations are collected under ONE trace (rather than N separate traces). When
   * telemetry is disabled, `fn` is called directly (no-op path). (Task 2, ADR-0012)
   */
  runInTrace: <T>(name: string, metadata: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;
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
   * (Task 2 — real API: `startActiveObservation(name, fn)`, callback receives `LangfuseSpan`;
   * `span.updateTrace` does NOT exist in v5.4.1 — use `span.update({ metadata })` instead.)
   */
  const runInTrace = <T>(name: string, metadata: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
    lfTracing.startActiveObservation(name, async (span) => {
      span.update({ metadata });
      return fn();
    }) as Promise<T>;

  return { enabled: true, callbackHandler, client, shutdown, runInTrace };
}
