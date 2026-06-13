import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelTier } from "../config/index.js";
import type { StructuredMethod } from "./structured.js";

/**
 * Which `withStructuredOutput` method to use for a provider. Groq's OpenAI-compatible endpoint
 * rejects `response_format: json_schema` for most models (e.g. llama-3.3-70b-versatile → HTTP 400),
 * so force `functionCalling` (tool-calling), which those models support (L1-02 fix). Anthropic and
 * OpenRouter keep the LangChain default (`undefined`).
 */
export function structuredMethodFor(provider: ModelTier["provider"]): StructuredMethod | undefined {
  return provider === "groq" ? "functionCalling" : undefined;
}

/** OpenRouter — OpenAI-compatible API; we connect via the ChatOpenAI baseURL (ADR-0002). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Groq — also OpenAI-compatible; same ChatOpenAI + baseURL path, no new dependency (L1-02). */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export interface ProviderKeys {
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  groqApiKey?: string;
}

/** Resolved model specification (pure result, no side effects). */
export type ModelSpec =
  | {
      provider: "anthropic";
      model: string;
      apiKey: string;
      temperature?: number;
      supportsVision: boolean;
    }
  | {
      provider: "openrouter";
      model: string;
      apiKey: string;
      baseURL: string;
      temperature?: number;
      supportsVision: boolean;
    }
  | {
      provider: "groq";
      model: string;
      apiKey: string;
      baseURL: string;
      temperature?: number;
      supportsVision: boolean;
    };

/**
 * Pure function: tier + keys → ModelSpec. Throws if the required provider's key is missing.
 * Separated from instantiation so it is fully testable without the SDK.
 */
export function resolveModelSpec(tier: ModelTier, keys: ProviderKeys): ModelSpec {
  if (tier.provider === "anthropic") {
    if (!keys.anthropicApiKey) {
      throw new Error(`Tier '${tier.model}' requires Anthropic, but ANTHROPIC_API_KEY is not set.`);
    }
    return {
      provider: "anthropic",
      model: tier.model,
      apiKey: keys.anthropicApiKey,
      temperature: tier.temperature,
      supportsVision: tier.supportsVision,
    };
  }
  if (tier.provider === "groq") {
    if (!keys.groqApiKey) {
      throw new Error(`Tier '${tier.model}' requires Groq, but GROQ_API_KEY is not set.`);
    }
    return {
      provider: "groq",
      model: tier.model,
      apiKey: keys.groqApiKey,
      baseURL: GROQ_BASE_URL,
      temperature: tier.temperature,
      supportsVision: tier.supportsVision,
    };
  }
  if (!keys.openrouterApiKey) {
    throw new Error(`Tier '${tier.model}' requires OpenRouter, but OPENROUTER_API_KEY is not set.`);
  }
  return {
    provider: "openrouter",
    model: tier.model,
    apiKey: keys.openrouterApiKey,
    baseURL: OPENROUTER_BASE_URL,
    temperature: tier.temperature,
    supportsVision: tier.supportsVision,
  };
}

/** Provider-agnostic factory: returns a LangChain `BaseChatModel` for the tier. */
export function makeModel(tier: ModelTier, keys: ProviderKeys): BaseChatModel {
  const spec = resolveModelSpec(tier, keys);
  const temperature = spec.temperature !== undefined ? { temperature: spec.temperature } : {};

  if (spec.provider === "anthropic") {
    return new ChatAnthropic({ model: spec.model, apiKey: spec.apiKey, ...temperature });
  }
  return new ChatOpenAI({
    model: spec.model,
    apiKey: spec.apiKey,
    configuration: { baseURL: spec.baseURL },
    ...temperature,
  });
}
