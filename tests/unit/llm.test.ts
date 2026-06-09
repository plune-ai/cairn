import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { resolveModelSpec, makeModel, imageBlock, OPENROUTER_BASE_URL } from "../../src/llm/index.js";
import type { ModelTier } from "../../src/config/index.js";

const anthropicTier: ModelTier = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  supportsVision: true,
};
const openrouterTier: ModelTier = {
  provider: "openrouter",
  model: "deepseek/deepseek-r1",
  supportsVision: false,
};
const keys = { anthropicApiKey: "sk-ant-test", openrouterApiKey: "sk-or-test" };

describe("resolveModelSpec — pure provider resolution", () => {
  it("anthropic tier → spec without baseURL, with the Anthropic key", () => {
    const spec = resolveModelSpec(anthropicTier, keys);
    expect(spec.provider).toBe("anthropic");
    expect(spec.model).toBe("claude-opus-4-8");
    expect(spec.apiKey).toBe("sk-ant-test");
    expect("baseURL" in spec).toBe(false);
  });

  it("openrouter tier → spec with the OpenRouter baseURL and OpenRouter key", () => {
    const spec = resolveModelSpec(openrouterTier, keys);
    expect(spec.provider).toBe("openrouter");
    expect(spec.model).toBe("deepseek/deepseek-r1");
    expect(spec.apiKey).toBe("sk-or-test");
    expect(spec.provider === "openrouter" && spec.baseURL).toBe(OPENROUTER_BASE_URL);
  });

  it("throws if the required provider key is missing", () => {
    expect(() => resolveModelSpec(anthropicTier, { openrouterApiKey: "x" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveModelSpec(openrouterTier, { anthropicApiKey: "x" })).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("makeModel — LangChain model instantiation", () => {
  it("anthropic tier → ChatAnthropic instance", () => {
    expect(makeModel(anthropicTier, keys)).toBeInstanceOf(ChatAnthropic);
  });

  it("openrouter tier → ChatOpenAI instance (via baseURL)", () => {
    expect(makeModel(openrouterTier, keys)).toBeInstanceOf(ChatOpenAI);
  });
});

describe("imageBlock — cross-provider image content block", () => {
  it("returns an image_url data-URL (shape to be confirmed by Spike S2)", () => {
    expect(imageBlock("AAAA", "image/png")).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });
});

describe("Spike S1 — zod 4 ↔ withStructuredOutput (build+binding, no network)", () => {
  it("makeModel(...).withStructuredOutput(zodSchema) type-checks and binds on zod 4.x", () => {
    const model = makeModel(anthropicTier, keys);
    const schema = z.object({ description: z.string(), count: z.number() });
    const structured = model.withStructuredOutput(schema);
    // If this compiles and does not throw, zod 4.x is compatible with withStructuredOutput in langchain 1.x.
    expect(structured).toBeDefined();
  });
});
