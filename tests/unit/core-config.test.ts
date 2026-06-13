import { describe, it, expect } from "vitest";
import { resolveConfig } from "../../src/core/config.js";

/**
 * C1-01: resolveConfig is the ONE place that maps CLI flags (--backend, --routing) onto the
 * env contract loadConfig reads. Previously this `{...process.env}` + override dance was
 * duplicated verbatim in the explore/design/automate commands.
 */
const baseEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENROUTER_API_KEY: "sk-or-test",
};

describe("resolveConfig (C1-01 — shared flag→config seam)", () => {
  it("with no flags, behaves like loadConfig(env) (defaults: anthropic + lib backend)", () => {
    const cfg = resolveConfig({}, { ...baseEnv });
    expect(cfg.llmProfile).toBe("anthropic");
    expect(cfg.browser.backend).toBe("lib");
    expect(cfg.roles).toBeUndefined();
  });

  it("--backend maps to BROWSER_BACKEND", () => {
    expect(resolveConfig({ backend: "cli" }, { ...baseEnv }).browser.backend).toBe("cli");
  });

  it("--routing maps to LLM_ROUTING (volume → cheap worker / smart reasoner)", () => {
    const cfg = resolveConfig({ routing: "volume" }, { ...baseEnv });
    expect(cfg.roles?.worker?.provider).toBe("openrouter");
    expect(cfg.roles?.reasoner?.provider).toBe("anthropic");
  });

  it("--backend and --routing compose", () => {
    const cfg = resolveConfig({ backend: "cli", routing: "volume" }, { ...baseEnv });
    expect(cfg.browser.backend).toBe("cli");
    expect(cfg.roles?.worker?.provider).toBe("openrouter");
  });

  it("absent flags do NOT clobber env values already set", () => {
    const cfg = resolveConfig({}, { ...baseEnv, BROWSER_BACKEND: "cli" });
    expect(cfg.browser.backend).toBe("cli"); // env wins because no flag overrides it
  });

  it("does not mutate the caller's env object (pure)", () => {
    const env = { ...baseEnv };
    resolveConfig({ backend: "cli", routing: "volume" }, env);
    expect("BROWSER_BACKEND" in env).toBe(false);
    expect("LLM_ROUTING" in env).toBe(false);
  });

  it("propagates loadConfig validation errors (e.g. a routed role with a missing key)", () => {
    // volume routes worker→OpenRouter; only the Anthropic key is present → must throw by role+provider
    expect(() => resolveConfig({ routing: "volume" }, { ANTHROPIC_API_KEY: "a" })).toThrow(
      /Role 'worker'.*OpenRouter/i,
    );
  });
});
