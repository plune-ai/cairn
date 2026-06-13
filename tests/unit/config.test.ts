import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";

/** Base valid env for the anthropic profile. */
const baseEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENROUTER_API_KEY: "sk-or-test",
};

describe("loadConfig — profiles (ADR-0002)", () => {
  it("defaults to the 'anthropic' profile with Opus reasoning (vision)", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.llmProfile).toBe("anthropic");
    expect(cfg.models.reasoning.provider).toBe("anthropic");
    expect(cfg.models.reasoning.model).toBe("claude-opus-4-8");
    expect(cfg.models.reasoning.supportsVision).toBe(true);
    expect(cfg.models.bulk.provider).toBe("anthropic");
    expect(cfg.models.judge.provider).toBe("anthropic");
  });

  it("'openrouter' profile — DeepSeek reasoning without vision, separate vision tier with vision", () => {
    const cfg = loadConfig({ ...baseEnv, LLM_PROFILE: "openrouter" });
    expect(cfg.models.reasoning.provider).toBe("openrouter");
    expect(cfg.models.reasoning.model).toContain("deepseek");
    expect(cfg.models.reasoning.supportsVision).toBe(false);
    expect(cfg.models.vision?.supportsVision).toBe(true);
  });

  it("'mixed' profile — reasoning on Anthropic, bulk on OpenRouter", () => {
    const cfg = loadConfig({ ...baseEnv, LLM_PROFILE: "mixed" });
    expect(cfg.models.reasoning.provider).toBe("anthropic");
    expect(cfg.models.bulk.provider).toBe("openrouter");
  });

  it("invalid LLM_PROFILE throws an error", () => {
    expect(() => loadConfig({ ...baseEnv, LLM_PROFILE: "gpt5" })).toThrow();
  });
});

describe("loadConfig — provider key validation", () => {
  it("anthropic profile without ANTHROPIC_API_KEY throws a clear error", () => {
    expect(() => loadConfig({ OPENROUTER_API_KEY: "x" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("openrouter profile without OPENROUTER_API_KEY throws a clear error", () => {
    expect(() => loadConfig({ LLM_PROFILE: "openrouter", ANTHROPIC_API_KEY: "x" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("mixed profile requires both keys", () => {
    expect(() => loadConfig({ LLM_PROFILE: "mixed", ANTHROPIC_API_KEY: "x" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });
});

describe("loadConfig — Langfuse (ADR-0006, self-hosted)", () => {
  it("disabled when keys are absent", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.langfuse.enabled).toBe(false);
  });

  it("enabled when baseUrl+publicKey+secretKey are present", () => {
    const cfg = loadConfig({
      ...baseEnv,
      LANGFUSE_BASE_URL: "https://lf.my-server.example",
      LANGFUSE_PUBLIC_KEY: "pk-lf-1",
      LANGFUSE_SECRET_KEY: "sk-lf-1",
    });
    expect(cfg.langfuse.enabled).toBe(true);
    expect(cfg.langfuse.baseUrl).toBe("https://lf.my-server.example");
  });
});

describe("loadConfig — CAIRN_ prefix + legacy env back-compat (C0-06)", () => {
  it("reads the new CAIRN_LLM_PROFILE", () => {
    const cfg = loadConfig({ ...baseEnv, CAIRN_LLM_PROFILE: "mixed" });
    expect(cfg.llmProfile).toBe("mixed");
  });

  it("CAIRN_-prefixed provider keys satisfy validation", () => {
    const cfg = loadConfig({ CAIRN_ANTHROPIC_API_KEY: "x", CAIRN_OPENROUTER_API_KEY: "y" });
    expect(cfg.llmProfile).toBe("anthropic");
    expect(cfg.anthropicApiKey).toBe("x");
  });

  it("legacy LEXBOT_LLM_PROFILE still works and warns toward CAIRN_LLM_PROFILE", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...baseEnv, LEXBOT_LLM_PROFILE: "openrouter" }, { warn });
    expect(cfg.llmProfile).toBe("openrouter");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("CAIRN_LLM_PROFILE");
  });

  it("current bare names keep working with no deprecation warning", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...baseEnv, LLM_PROFILE: "mixed" }, { warn });
    expect(cfg.llmProfile).toBe("mixed");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("loadConfig — browser and maxRepair", () => {
  it("backend defaults to 'lib'", () => {
    expect(loadConfig({ ...baseEnv }).browser.backend).toBe("lib");
  });

  it("BROWSER_BACKEND=cli is accepted", () => {
    expect(loadConfig({ ...baseEnv, BROWSER_BACKEND: "cli" }).browser.backend).toBe("cli");
  });

  it("invalid backend throws an error", () => {
    expect(() => loadConfig({ ...baseEnv, BROWSER_BACKEND: "puppeteer" })).toThrow();
  });

  it("maxRepair defaults to 2, overridable via MAX_REPAIR", () => {
    expect(loadConfig({ ...baseEnv }).maxRepair).toBe(2);
    expect(loadConfig({ ...baseEnv, MAX_REPAIR: "4" }).maxRepair).toBe(4);
  });

  it("testCaseLanguage: defaults to English; QA_TESTCASE_LANG override (codes + names)", () => {
    expect(loadConfig({ ...baseEnv }).testCaseLanguage).toBe("English");
    expect(loadConfig({ ...baseEnv, QA_TESTCASE_LANG: "uk" }).testCaseLanguage).toBe("Ukrainian");
    expect(loadConfig({ ...baseEnv, QA_TESTCASE_LANG: "Ukrainian" }).testCaseLanguage).toBe("Ukrainian");
    expect(loadConfig({ ...baseEnv, QA_TESTCASE_LANG: "Deutsch" }).testCaseLanguage).toBe("Deutsch");
  });
});

describe("loadConfig — per-role routing is additive + backward-compatible (L1-01)", () => {
  it("no routing config → roles undefined, profile/tier map unchanged (behaves as today)", () => {
    const cfg = loadConfig({ ...baseEnv, LLM_PROFILE: "anthropic" });
    expect(cfg.roles).toBeUndefined();
    expect(cfg.models.reasoning.model).toBe("claude-opus-4-8");
    expect(cfg.models.bulk.model).toBe("claude-sonnet-4-6");
    expect(cfg.models.judge.model).toBe("claude-haiku-4-5");
  });

  it("every LLM_PROFILE still resolves its tier map unchanged (no roles)", () => {
    expect(loadConfig({ ...baseEnv, LLM_PROFILE: "openrouter" }).roles).toBeUndefined();
    expect(loadConfig({ ...baseEnv, LLM_PROFILE: "mixed" }).roles).toBeUndefined();
  });

  it("LLM_ROUTING=volume → worker=OpenRouter (cheap), reasoner=Anthropic (smart)", () => {
    const cfg = loadConfig({ ...baseEnv, LLM_ROUTING: "volume" });
    expect(cfg.roles?.worker?.provider).toBe("openrouter");
    expect(cfg.roles?.worker?.model).toBe("deepseek/deepseek-chat");
    expect(cfg.roles?.reasoner?.provider).toBe("anthropic");
    expect(cfg.roles?.reasoner?.model).toBe("claude-opus-4-8");
    // routing does NOT touch the profile tiers (incl. the cheap judge scorer)
    expect(cfg.models.judge.model).toBe("claude-haiku-4-5");
  });

  it("missing provider key for a routed role → error names ROLE + PROVIDER", () => {
    // volume routes worker→OpenRouter, but only ANTHROPIC_API_KEY is set
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "a", LLM_ROUTING: "volume" })).toThrow(
      /Role 'worker'.*OpenRouter/i,
    );
  });

  it("CAIRN_ROLE_WORKER=provider:model remaps the role", () => {
    const cfg = loadConfig({ ...baseEnv, CAIRN_ROLE_WORKER: "openrouter:deepseek/deepseek-chat" });
    expect(cfg.roles?.worker).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      supportsVision: false,
    });
    expect(cfg.roles?.reasoner).toBeUndefined(); // unset role falls back to the tier default
  });

  it("explicit override composes over a preset (override wins)", () => {
    const cfg = loadConfig({
      ...baseEnv,
      LLM_ROUTING: "volume",
      CAIRN_ROLE_REASONER: "openrouter:deepseek/deepseek-r1",
    });
    expect(cfg.roles?.worker?.provider).toBe("openrouter"); // from preset
    expect(cfg.roles?.reasoner?.model).toBe("deepseek/deepseek-r1"); // overridden
  });

  it("unknown role in CAIRN_ROLE_* → warning + ignored (falls back to default)", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...baseEnv, CAIRN_ROLE_TYPO: "anthropic:claude-opus-4-8" }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown role/i));
    expect(cfg.roles).toBeUndefined();
  });

  it("unknown LLM_ROUTING preset → warning + no routing (graceful)", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...baseEnv, LLM_ROUTING: "bogus" }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown.*routing preset/i));
    expect(cfg.roles).toBeUndefined();
  });

  it("invalid provider in CAIRN_ROLE_* → clear error", () => {
    expect(() => loadConfig({ ...baseEnv, CAIRN_ROLE_WORKER: "groq:llama" })).toThrow(
      /Invalid provider 'groq'/i,
    );
  });
});
