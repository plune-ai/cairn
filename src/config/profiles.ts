import type { LlmProfile, ModelsConfig, RolesConfig } from "./schema.js";

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

/**
 * Named role-routing presets (L1-01, ADR-0011). Layered OVER a profile's tier map:
 * a preset only sets the routable roles (`worker`/`reasoner`); the cheap `judge`
 * scorer tier still comes from `LLM_PROFILE`. Selected via `LLM_ROUTING=<name>`.
 *
 * `volume` = run cheaply at scale (Explorbot-style): the mechanical worker steps on a
 * cheap OpenRouter model, the judgment steps (designTestCases + Pilot verdict) on Claude.
 *
 * `fast` (L1-02) = the one-flag low-latency preset: the worker on Groq (lowest latency/cost,
 * OpenAI-compatible tool-calling), the reasoner still on Claude Opus (keep judgment strong).
 * Both presets compose with `LLM_PROFILE` and stay overridable via `CAIRN_ROLE_<NAME>`.
 *
 * `volume-fast` (#110) = the latency-safe sibling of `volume`: codegen/analyze (worker) move to
 * Anthropic Sonnet — `deepseek/deepseek-chat` is pathologically slow on large codegen (4.5–13 min)
 * — while the cheap LLM-as-judge scorer stays on OpenRouter via `LLM_PROFILE`. Unlike `fast`, the
 * worker is NOT Groq (Groq's OpenAI-compat endpoint 400s on large-codegen json_schema, see
 * `groq-fast-json-schema-bug`), so this preset is the recommended escape for slow OpenRouter codegen.
 */
export const ROUTING_PRESETS: Record<string, RolesConfig> = {
  volume: {
    // worker spans identifyElements(vision) + generateCode/repair(bulk) → one cheap text model.
    // supportsVision:false → identifyElements falls back to aria-only (ADR-0002, vision-optional).
    worker: { provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false },
    // reasoner = designTestCases + Pilot verdict → quality model.
    reasoner: { provider: "anthropic", model: "claude-opus-4-8", supportsVision: false },
  },
  "volume-fast": {
    // worker (codegen + analyze) → Anthropic Sonnet: fast, finishes in ~90s where deepseek-chat
    // overruns interactive/MCP timeouts (#110). supportsVision:false → identifyElements aria-only.
    worker: { provider: "anthropic", model: "claude-sonnet-4-6", supportsVision: false },
    // reasoner = designTestCases + Pilot verdict → Anthropic Opus (also avoids the deepseek-r1 hang).
    reasoner: { provider: "anthropic", model: "claude-opus-4-8", supportsVision: false },
  },
  fast: {
    // worker → Groq llama-3.3-70b-versatile: lowest latency/cost. This model does NOT support
    // response_format=json_schema, so structured output goes via tool/function-calling
    // (structuredMethodFor("groq") → "functionCalling", L1-02 fix). supportsVision:false →
    // identifyElements falls back to aria-only (ADR-0002). Model id overridable via CAIRN_ROLE_WORKER.
    worker: { provider: "groq", model: "llama-3.3-70b-versatile", supportsVision: false },
    // reasoner = designTestCases + Pilot verdict → keep the quality model (Anthropic Opus).
    reasoner: { provider: "anthropic", model: "claude-opus-4-8", supportsVision: false },
  },
};
