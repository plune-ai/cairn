import { describe, it, expect, vi } from "vitest";
import { initTelemetry } from "../../src/telemetry/index.js";
import type { AppConfig } from "../../src/config/index.js";

// The root trace's Input and Output were `undefined` in Langfuse. With `@langfuse/*` v6 the trace takes its
// input and output from the root observation, so the root span must carry both. A fake tracer records them.
const spy = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[] }));
vi.mock("@opentelemetry/sdk-node", () => ({ NodeSDK: class { start() {} async shutdown() {} } }));
vi.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: class { async forceFlush() {} } }));
vi.mock("@langfuse/langchain", () => ({ CallbackHandler: class {} }));
vi.mock("@langfuse/client", () => ({ LangfuseClient: class { score = { flush: async () => undefined, create: () => undefined }; } }));
vi.mock("@langfuse/tracing", () => ({
  startActiveObservation: (_name: string, fn: (span: unknown) => unknown) =>
    fn({ update: (attrs: Record<string, unknown>) => spy.updates.push(attrs) }),
  startObservation: () => undefined,
  getActiveTraceId: () => undefined,
}));

describe("initTelemetry · runInTrace sets the root trace's input and output", () => {
  it("puts {url, runId} as input and the run result, without the screenshot, as output", async () => {
    const cfg = { langfuse: { enabled: true, baseUrl: "http://lf.local", publicKey: "pk", secretKey: "sk" } } as AppConfig;
    const tel = await initTelemetry(cfg);
    const testCases = [{ id: "tc-1", title: "loads the page" }];
    const result = { runId: "r1", study: { url: "https://app.test/", screenshotB64: "iVBORw0KGgo", elements: [] }, testCases };

    const got = await tel.runInTrace("design", { metadata: { runId: "r1" }, input: { url: "https://app.test/", runId: "r1" } }, async () => result);

    expect(got).toBe(result);
    const merged = Object.assign({}, ...spy.updates) as { input?: unknown; output?: { testCases?: unknown; study?: Record<string, unknown> } };
    expect(merged.input).toEqual({ url: "https://app.test/", runId: "r1" });
    expect(merged.output?.testCases).toEqual(testCases);
    expect(merged.output?.study).toEqual({ url: "https://app.test/", elements: [] });
    expect(result.study.screenshotB64).toBe("iVBORw0KGgo"); // the caller's result is left as it was
  });
});
