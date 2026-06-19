# ADR-0006: Observability and self-improvement on Langfuse v5 (OTel), self-hosted

- **Status:** Accepted · **Revised:** 2026-06-08 (default hosting: Cloud → **self-hosted**)
- **Decision in code:** `src/telemetry/`, `src/eval/`

## Context

The user's requirement: the bot must **improve** — collect data, judge quality, deploy improvements.
A substrate is needed with tracing, scoring/LLM-as-judge, prompt versioning, and regression experiments,
with integration into the LangChain-core LLM layer. **The user already has their own self-hosted Langfuse on their server.**

## Decision

- **Langfuse v5** (OpenTelemetry-based): `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`,
  `@langfuse/langchain` (CallbackHandler) + `@opentelemetry/sdk-node`.
- Bootstrap once in `telemetry/`: OTel `NodeSDK` + `LangfuseSpanProcessor`; flush on exit.
- **Default hosting is SELF-HOSTED (the user's server):** `LANGFUSE_BASE_URL` points to their instance;
  `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` come from it. (Cloud remains possible via an env change.)
- We use: **tracing** (a root span via `startActiveObservation` + the `@langfuse/langchain` `CallbackHandler` threaded into each LLM call by `RoleRouter`; each stage's LLM call becomes a nested generation), **scores** (`score.create`/`observation`),
  **Datasets + `runExperiment()`** (bot regression), **prompt management**.
- **LLM-as-judge — SDK-side (NOT server-managed evaluators):** we call the judge model ourselves in `eval/judge.ts`
  / the `score` node, and write scores via the SDK. This way the loop **does not depend** on Cloud/Enterprise features and is fully
  portable to any self-hosted instance.

## Consequences

- (+) The whole improvement loop (trace→score→dataset→experiment→promote) runs on your server; data doesn't go to the cloud.
- (+) SDK-side judges → provider-agnostic (Anthropic or OpenRouter, ADR-0002) and independent of Langfuse EE features.
- (−) **v5 is OTel-first, a new API** → confirmed by **Spike S5** (Sprint 0), including against the self-hosted instance.
- (−) We must **confirm that your self-hosted Langfuse version supports Datasets + Experiments** (usually OSS;
  verify at S5). Cost tracking of OpenRouter models may require custom model pricing.
- (−) Network/access: keys from your instance; possible self-signed TLS / VPN nuances (record in the runbook).

## Rejected alternatives

- **Langfuse Cloud** — zero ops, but data in the cloud; the user already has their own server → self-hosted is more appropriate.
- **Server-managed LLM-as-judge** — convenient, but a Cloud/EE dependency; SDK-side judges are more portable.
- **LangSmith / a custom telemetry** — weaker datasets/judges or a huge amount of work to reproduce the UI.
