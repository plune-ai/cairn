# ADR-0011: Per-role model routing (worker/reasoner) + per-run cost/token reporting

- **Status:** Accepted · **Date:** 2026-06-13 · **Issue:** [L1-01 (#6)](https://github.com/plune-ai/cairn/issues/6)
- **Decision in code:** `src/llm/routing.ts`, `src/llm/cost.ts`, `src/config/{schema,profiles,index}.ts`, wiring in `src/agent/index.ts`

## Context

Model selection was already **per-node**, but keyed by a 4-**tier** map (`ModelsConfig = { reasoning, bulk, judge, vision }`) selected wholesale by `LLM_PROFILE` (ADR-0002). Two gaps:

1. **No named cost intent.** Users want to run Cairn *cheaply at volume* (a cheap/fast model for mechanical LLM steps) OR *at Claude quality* (a strong model for judgment steps) — their choice. Tiers don't express that intent: the mechanical "worker" work spans two tiers (`vision` for page analysis, `bulk` for code generation), and the judgment work spans `reasoning` (case design) plus the Pilot verdict.
2. **No cost/token visibility.** `CallBudget` counts *calls* as a guardrail; `structuredInvoker` discarded `withStructuredOutput().invoke()` usage; `report.ts` had no cost fields. There was no way to see what a run actually cost, per anything.

The brief's word **"judge"** for the strong role clashes with the existing config tier **`judge`**, which is the *cheap* LLM-as-judge scorer (Haiku/Qwen) — the opposite cost intent.

## Decision

A **thin named-role layer over the existing tier map**, plus per-role cost/token capture. Node logic and the graph are unchanged.

### 1. Roles

Two routable roles, named to avoid the `judge` clash:

| Role | Steps | Default tier (no routing) |
|---|---|---|
| `worker` | identifyElements (vision), generateCode (bulk), repair (bulk) | `vision ?? reasoning`, `bulk`, `bulk` |
| `reasoner` | designTestCases, **Pilot verdict** | `reasoning`, `reasoning` |

A role **does not own a tier** — it resolves to one: `resolveRoleTier(role, fallbackTier, cfg.roles) = cfg.roles[role] ?? fallbackTier`. With no routing config, every role resolves to exactly today's tier ⇒ backward-compatible by construction.

The cheap LLM-as-judge scorer (`judgeTestCases`, `judgeChecklistCoverage`) keeps the `judge` tier and is **NOT routable** — it is metered-only, under a `judge` bucket, so totals stay honest.

### 2. Config / env override (additive over `LLM_PROFILE`)

- `LLM_ROUTING=<preset>` selects a named **routing preset**. Built-in: **`volume`** = `worker`→cheap OpenRouter (`deepseek/deepseek-chat`) + `reasoner`→Anthropic (`claude-opus-4-8`).
- `CAIRN_ROLE_WORKER` / `CAIRN_ROLE_REASONER` = `provider:model` give explicit per-role overrides (which win over a preset).
- `LLM_PROFILE` still selects the tier map unchanged; routing layers on top (`cfg.roles?`). Unknown preset / unknown role → **warn + fall back** to the tier default. A routed role with a missing provider key → error naming **role + provider**.
- CLI: `--routing <preset>` on `explore` / `design` / `automate`.

### 3. Per-role cost + tokens (the new plumbing)

- `meteredInvoker` reads usage off the LangChain response via `withStructuredOutput(schema, { includeRaw: true })` → `usage_metadata` (fallback `response_metadata.usage` / `tokenUsage`); never throws.
- A `CostLedger` (sibling of `CallBudget`, one per run, owned by `RoleRouter`) attributes usage to the role, prices it, and renders `perRole` + totals into `report.md`, `report.json`, the CLI summary, and the public `ExploreResult/DesignResult/AutomateResult.cost`.
- Pricing: Anthropic list prices are authoritative; OpenRouter prices are approximate/movable (per ADR-0002) — any model absent from the table yields a **null cost** (tokens still reported), never a crash.

## Consequences

- (+) Users get the Explorbot-style cost play (`LLM_ROUTING=volume`) or all-Claude quality (`anthropic` profile) without touching node logic — routing is one resolution step at graph-build time.
- (+) Honest per-run cost/token reporting, per role, everywhere a run is summarized.
- (+) Fully backward-compatible: no routing config ⇒ identical to today; `LLM_PROFILE` untouched.
- (−) **Behavior change:** the Pilot verdict now runs on `reasoner` (the strong model) instead of the cheap `judge` tier — intended ("smart judge"), but it raises Pilot cost on the default profile. Flagged in the PR.
- (−) For `volume`, the `worker` model is text-only (`deepseek/deepseek-chat`), so identifyElements falls back to aria-only (ADR-0002 vision-optional) — an accepted cost/vision trade-off for the cheap preset.
- (−) OpenRouter cost is an estimate until the price table is tuned (ADR-0002); a missing price shows tokens with `n/a` cost.

## Rejected alternatives

- **Reuse the config tier `judge` for the strong role** — opposite cost intent (cheap scorer); guaranteed confusion. Used distinct names `worker`/`reasoner` instead.
- **Make `volume` a new `LLM_PROFILE`** — a profile is a *tier* map; `volume` is *role* intent, and lives orthogonally to the profile so it composes with any tier map (incl. the cheap `judge` scorer staying on the profile).
- **Route `observe`/`ground`** — they make no LLM calls; routing there is a no-op.
- **Track cost in Langfuse only** — Langfuse is self-hosted and optional; the run summary must work offline, so the ledger is SDK-side.
