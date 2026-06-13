# ADR-0002: Multi-provider LLM layer (Anthropic + OpenRouter) with tier×provider mapping

- **Status:** Accepted · **Revised:** 2026-06-13 (L1-02: Groq added as a third OpenAI-compatible provider) · 2026-06-08 (expanded from "Anthropic only" to multi-provider)
- **Decision in code:** `src/llm/` (provider-agnostic model factory)

## Context

The bot needs: (1) **vision** (screenshots), (2) strong reasoning (case design), (3) cheap bulk
code generation, (4) cheap bulk **judging**. Anthropic gives the highest quality, but is **globally expensive on the API**.
An **economical alternative** is needed via **OpenRouter** (access to DeepSeek, Qwen, etc.) — NOT a replacement
for Anthropic, but a switchable option.

## Decision

A provider-agnostic factory `makeModel(tier)` that returns a LangChain `BaseChatModel`. Two adapters:

- **Anthropic:** `ChatAnthropic` (`@langchain/anthropic`).
- **OpenRouter:** `ChatOpenAI` (`@langchain/openai`) with `configuration.baseURL = "https://openrouter.ai/api/v1"`
  and `apiKey = OPENROUTER_API_KEY` (OpenRouter is an OpenAI-compatible API). Optional headers `HTTP-Referer`/`X-Title`.
- **Groq (L1-02):** also `ChatOpenAI` with `configuration.baseURL = "https://api.groq.com/openai/v1"` and
  `apiKey = GROQ_API_KEY` — Groq is OpenAI-compatible too, so it **reuses the same adapter, no new dependency**.
  Surfaced as the `fast` routing preset's worker (lowest latency/cost); see the ADR-0011 addendum.

The config maps **each tier → `{ provider, model, supportsVision }`**. Profiles (examples, configurable):

| Tier | `anthropic` (quality, default) | `openrouter` (economy) |
|------|------------------------------|--------------------------|
| reasoning | `claude-opus-4-8` | `deepseek/deepseek-r1` |
| bulk (codegen) | `claude-sonnet-4-6` | `deepseek/deepseek-chat` / `qwen/qwen-2.5-72b-instruct` |
| judge (cheap) | `claude-haiku-4-5` | `qwen/qwen-2.5-72b-instruct` (or smaller) |
| vision | `claude-opus-4-8` / `claude-haiku-4-5` | a vision model (e.g. `qwen/qwen-2-vl-72b-instruct`) |

The profile can be **mixed** (e.g. vision on Anthropic-Haiku, bulk+judge on OpenRouter) — the main
cost lever: cheap models where the volume is large (codegen, judging), Claude — where quality is critical.

> The exact OpenRouter model ids are confirmed during setup (they move) — see Spike S6.

## Vision — OPTIONAL (a key consequence of multi-provider)

DeepSeek models are text-only, without vision. So `identifyElements` works in two modes:
- **vision:** screenshot + ARIA (when `supportsVision: true`);
- **aria-only:** only the text ARIA snapshot (for text models like DeepSeek) — lower quality on
  visually-complex pages, but fully functional.

The factory/node selects the mode based on the `supportsVision` flag of the configured model.

## Consequences

- (+) Drastic cost flexibility: an economical profile/mix instead of the expensive Anthropic.
- (+) A single `BaseChatModel` interface → the nodes are provider-agnostic; `withStructuredOutput`, callbacks, Langfuse tracing all work the same.
- (−) **Structured output reliability varies** between models (open models hold a JSON schema worse) → Spike S6 + JSON-repair/retry.
- (−) **Vision isn't everywhere** → aria-only fallback (above).
- (−) Langfuse cost tracking for OpenRouter models may require custom model pricing in your self-hosted instance.
- (−) The param surface differs (Opus 4.8 adaptive-only; OpenAI-compatible take `temperature`, etc.) → encapsulate in the factory.

## Rejected alternatives

- **Anthropic only** — the highest quality, but expensive; contradicts the explicit requirement for an economical alternative.
- **The providers' direct SDKs** — loss of the shared LangChain interface and the Langfuse callback.
- **A separate community package for OpenRouter** — unnecessary; the canonical path is `ChatOpenAI` + `baseURL`.
