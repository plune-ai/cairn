# ADR-0004: Prompts as a versioned artifact in Langfuse (+ local fallback)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision in code:** `src/prompts/PromptRegistry.ts`, `src/prompts/local/*`

## Context

The bot's "skill" (the testing methodology) is its prompts. For the bot to **improve**, the prompts must be
versioned, measurable, and promotable separately from the code. At the same time, the bot must work offline
and on first start (before seeding into Langfuse).

## Decision

- Prompts live in **Langfuse Prompt Management**; runtime-fetch `getPrompt(name, {label:'production'})`.
- A **mandatory local fallback** (`src/prompts/local/*.md|json`) — if Langfuse is unavailable or empty.
- `PromptRegistry.getPrompt(name, vars?)` returns `CompiledPrompt { text|messages, version, isFallback }`
  with variable interpolation; each generation links the prompt version (for regression attribution).
- **Promotion via label:** a new version → label `candidate` → experiment → (on evidence) move `production`.
  Deploy = move label; rollback = move back.

## Consequences

- (+) Prompts are iterated without a code release; a regression is attributed to a specific version.
- (+) The local fallback = the bot doesn't crash without the network/Langfuse.
- (+) A direct foundation for the self-improvement loop (see `architecture/self-improvement.md`).
- (−) Two copies of the truth (Langfuse + local) → sync discipline; local is the baseline, Langfuse is the "live" version.
- (−) Dependence on the Prompt Management API (fast-moving) — we wrap it in `PromptRegistry`, isolating changes.

## Rejected alternatives

- **Prompts hardcoded in the code** — not versioned independently, every edit = a release, no measurement.
- **LangSmith Hub** — simpler versioning, but weaker eval/experiment features; Langfuse gives tracing + datasets + judges in one.
- **Local files + git only** — versioning exists, but there's no runtime promotion or link to scores/experiments.
