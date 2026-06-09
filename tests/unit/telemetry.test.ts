import { describe, it, expect } from "vitest";
import { initTelemetry } from "../../src/telemetry/index.js";
import { loadConfig } from "../../src/config/index.js";

describe("initTelemetry — disabled (offline) path", () => {
  it("returns no-op telemetry when Langfuse is disabled", async () => {
    // Without LANGFUSE_* keys → langfuse.enabled === false.
    const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(cfg.langfuse.enabled).toBe(false);

    const tel = initTelemetry(cfg);
    expect(tel.enabled).toBe(false);
    expect(tel.callbackHandler).toBeUndefined();
    await expect(tel.shutdown()).resolves.toBeUndefined();
  });
});
