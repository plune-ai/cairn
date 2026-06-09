import { describe, it, expect } from "vitest";
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
