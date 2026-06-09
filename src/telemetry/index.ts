import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseClient } from "@langfuse/client";
import type { AppConfig } from "../config/index.js";

/**
 * Bot telemetry (ADR-0006). Langfuse v5 — OTel-first:
 * `LangfuseSpanProcessor` is registered in `NodeSDK` and exports spans to the self-hosted instance;
 * `CallbackHandler` only emits OTel spans (its constructor does NOT take keys);
 * `LangfuseClient` — for scores/datasets/prompts (SDK-side judges, ADR-0006).
 */
export interface Telemetry {
  enabled: boolean;
  callbackHandler?: CallbackHandler;
  client?: LangfuseClient;
  shutdown: () => Promise<void>;
}

/**
 * Telemetry bootstrap. If Langfuse is disabled (no keys) — returns a no-op so the bot
 * works offline (ADR-0004/0006). The enabled path is verified by the live Spike S5.
 */
export function initTelemetry(cfg: AppConfig): Telemetry {
  if (!cfg.langfuse.enabled) {
    return { enabled: false, shutdown: async () => {} };
  }

  const { baseUrl, publicKey, secretKey } = cfg.langfuse;

  const spanProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();

  const client = new LangfuseClient({ publicKey, secretKey, baseUrl });
  const callbackHandler = new CallbackHandler();

  const shutdown = async (): Promise<void> => {
    await client.score.flush().catch(() => undefined); // flush remaining scores (B1)
    await spanProcessor.forceFlush();
    await sdk.shutdown();
  };

  return { enabled: true, callbackHandler, client, shutdown };
}
