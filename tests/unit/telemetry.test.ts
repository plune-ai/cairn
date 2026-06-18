import { describe, it, expect, vi } from "vitest";
import { initTelemetry } from "../../src/telemetry/index.js";
import { loadConfig } from "../../src/config/index.js";
import type { AppConfig } from "../../src/config/index.js";

// FIX D (0.3.3): @opentelemetry/* and @langfuse/* are OPTIONAL peers — not in the default install.
// Simulate their absence: the lazy import() rejects, and the capability check must no-op rather
// than crash a run that is otherwise fully functional.
vi.mock("@opentelemetry/sdk-node", () => {
  throw new Error("Cannot find module '@opentelemetry/sdk-node'");
});

describe("initTelemetry — disabled (offline) path", () => {
  it("returns no-op telemetry when Langfuse is disabled", async () => {
    // Without LANGFUSE_* keys → langfuse.enabled === false (never reaches the optional imports).
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(cfg.langfuse.enabled).toBe(false);

    const tel = await initTelemetry(cfg);
    expect(tel.enabled).toBe(false);
    expect(tel.callbackHandler).toBeUndefined();
    await expect(tel.shutdown()).resolves.toBeUndefined();
  });
});

describe("initTelemetry — optional tracing packages absent (FIX D capability check)", () => {
  it("no-ops (does not crash) when Langfuse is configured but the packages are missing", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errs.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    // Langfuse enabled, but the lazy import() rejects (mocked above) → graceful no-op + one hint.
    const cfg = {
      langfuse: { enabled: true, baseUrl: "http://lf.local", publicKey: "pk", secretKey: "sk" },
    } as AppConfig;

    const tel = await initTelemetry(cfg);
    expect(tel.enabled).toBe(false);
    expect(tel.callbackHandler).toBeUndefined();
    await expect(tel.shutdown()).resolves.toBeUndefined();
    expect(errs.join("")).toMatch(/without tracing/i);
    spy.mockRestore();
  });
});
