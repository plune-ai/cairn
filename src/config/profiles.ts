import type { LlmProfile, ModelsConfig } from "./schema.js";

/**
 * Default model profiles (ADR-0002). Exact OpenRouter model-ids are confirmed by Spike S6;
 * everything is overridable via custom configuration.
 */
export const PROFILES: Record<LlmProfile, ModelsConfig> = {
  // Quality, more expensive.
  anthropic: {
    reasoning: { provider: "anthropic", model: "claude-opus-4-8", supportsVision: true },
    bulk: { provider: "anthropic", model: "claude-sonnet-4-6", supportsVision: false },
    judge: { provider: "anthropic", model: "claude-haiku-4-5", supportsVision: false },
    vision: { provider: "anthropic", model: "claude-haiku-4-5", supportsVision: true },
  },
  // Economical: DeepSeek/Qwen. reasoning has no vision → the vision-tier provides Qwen-VL.
  openrouter: {
    reasoning: { provider: "openrouter", model: "deepseek/deepseek-r1", supportsVision: false },
    bulk: { provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false },
    judge: { provider: "openrouter", model: "qwen/qwen-2.5-72b-instruct", supportsVision: false },
    vision: { provider: "openrouter", model: "qwen/qwen-2-vl-72b-instruct", supportsVision: true },
  },
  // Balanced: high-quality reasoning+vision on Anthropic, cheap bulk+judge on OpenRouter.
  mixed: {
    reasoning: { provider: "anthropic", model: "claude-opus-4-8", supportsVision: true },
    bulk: { provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false },
    judge: { provider: "openrouter", model: "qwen/qwen-2.5-72b-instruct", supportsVision: false },
    vision: { provider: "anthropic", model: "claude-haiku-4-5", supportsVision: true },
  },
};
