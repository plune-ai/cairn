# ADR-0001: TypeScript language + plain async pipeline (formerly LangGraph.js v1)

- **Status:** Accepted · **Partially superseded by ADR-0013** (the LangGraph orchestration layer was removed in 0.4.0; the TypeScript + LangChain-core language choice remains)
- **Date:** 2026-06-08
- **Decision in code:** `src/agent/graph.ts`, `src/agent/state.ts`

## Context

The bot must be embeddable into a working project that is also in TypeScript. We need an agentic runtime with
an "observe → reason → act" loop, with branching (checklist? validation failure → repair?), state
between steps, and nested tracing.

## Decision

- Language — **TypeScript** (Node.js 20+), ESM/NodeNext, strict.
- Agent — originally **LangGraph.js v1** (`@langchain/langgraph`), the **StateGraph** pattern with `Annotation.Root` channels
  and `addConditionalEdges`. **Replaced in 0.4.0 (ADR-0013)** by a plain async pipeline (`runExploreGraph`) that runs the same
  stages as sequential awaits over the same service seams (`BrowserGateway`, `StructuredInvoke`).
  Models — via `@langchain/anthropic`; structured output — `withStructuredOutput()` + Zod;
  custom tools — `tool()` from `@langchain/core/tools`.

## Why not the legacy AgentExecutor

`createReactAgent`/`AgentExecutor` is sequential tool-calling without explicit state and graph management.
A plain async pipeline provides explicit, testable stage ordering and bounded loops (repair) without the
overhead of the LangGraph DSL.

## Consequences

- (+) An explicit, testable pipeline; Langfuse tracing is bound at the LLM layer via a root span + callback handler.
- (+) A shared language with the working project — easy embedding.
- (−) `withStructuredOutput` sensitivity to the Zod version → pin `~3.25.67` (**Spike S1**, ADR note).

## Rejected alternatives

- **AgentExecutor (legacy)** — less control over state/loops; being phased out of the ecosystem.
- **Python** — doesn't match the working project's stack.

> **See also:** ADR-0013 for the rationale and consequences of removing `@langchain/langgraph` specifically.
