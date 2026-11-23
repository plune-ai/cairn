import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelTier } from "../config/index.js";
import type { StructuredMethod } from "./structured.js";

/**
 * Which `withStructuredOutput` method to use for a provider. Groq's OpenAI-compatible endpoint
 * rejects `response_format: json_schema` for most models (e.g. llama-3.3-70b-versatile → HTTP 400),
 * so force `functionCalling` (tool-calling), which those models support (L1-02 fix). OpenRouter and the
 * older Claude models keep the LangChain default (`undefined`).
 */
export function structuredMethodFor(provider: ModelTier["provider"], model = ""): StructuredMethod | undefined {
  if (provider === "groq") return "functionCalling";
  // LangChain's Anthropic default is functionCalling = forced `tool_choice: {type: "tool"}`, which Opus 5.5 and
  // Sonnet 5.5 answer with 400; `jsonSchema` sends `output_config.format` instead (structured outputs).
  if (provider === "anthropic" && isAdaptiveGeneration(model)) return "jsonSchema";
  return undefined;
}

/** Claude 4.7 and later reject a non-default `temperature` (and API version 2026-10-21 drops it everywhere). */
export function rejectsSampling(model: string): boolean {
  return /^claude-(opus-4-[7-9]|(opus|sonnet|haiku)-[5-9]|fable|mythos)/.test(model);
}

/**
 * The 5.x generation thinks by default; Opus 5.5 and Sonnet 5.5 answer `thinking: {type: "disabled"}` (LangChain's
 * default) with 400, so these get adaptive thinking, structured outputs and room for thinking plus the reply.
 */
function isAdaptiveGeneration(model: string): boolean {
  return /^claude-((opus|sonnet|haiku)-[5-9]|fable|mythos)/.test(model);
}

/** Non-streaming cap that fits thinking + reply under the SDK's HTTP timeout. */
const ADAPTIVE_MAX_TOKENS = 16000;

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
    if (spec.temperature !== undefined && rejectsSampling(spec.model)) {
      console.warn(`temperature ${spec.temperature} is ignored for ${spec.model}: Claude 4.7+ models reject it.`);
      return makeAnthropic(spec.model, spec.apiKey, {});
    }
    return makeAnthropic(spec.model, spec.apiKey, temperature);
  }
  return new ChatOpenAI({
    model: spec.model,
    apiKey: spec.apiKey,
    configuration: { baseURL: spec.baseURL },
    ...temperature,
  });
}

function makeAnthropic(model: string, apiKey: string, temperature: { temperature?: number }): ChatAnthropic {
  const adaptive = isAdaptiveGeneration(model)
    ? { thinking: { type: "adaptive" as const }, maxTokens: ADAPTIVE_MAX_TOKENS }
    : {};
  return new ChatAnthropic({ model, apiKey, ...temperature, ...adaptive });
}
