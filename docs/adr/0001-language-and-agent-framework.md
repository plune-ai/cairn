# ADR-0001: TypeScript language + LangGraph.js v1 (StateGraph)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision in code:** `src/agent/graph.ts`, `src/agent/state.ts`

## Context

The bot must be embeddable into a working project that is also in TypeScript. We need an agentic runtime with
an "observe → reason → act" loop, with branching (checklist? validation failure → repair?), state
between steps, and nested tracing.

## Decision

- Language — **TypeScript** (Node.js 20+), ESM/NodeNext, strict.
- Agent — **LangGraph.js v1** (`@langchain/langgraph`), the **StateGraph** pattern with `Annotation.Root` channels
  and `addConditionalEdges`. Models — via `@langchain/anthropic`; structured output — `withStructuredOutput()` + Zod;
  custom tools — `tool()` from `@langchain/core/tools`.

## Why not the legacy AgentExecutor

`createReactAgent`/`AgentExecutor` is sequential tool-calling without explicit state and graph management.
StateGraph provides incremental state updates, explicit topology, conditional edges, and bounded loops
(repair), which our process directly needs.

## Consequences

- (+) An explicit, testable graph; nested tracing fits naturally (one node = one generation).
- (+) A shared language with the working project — easy embedding.
- (−) LangGraph v1 is a fast-moving API; exact versions/idioms are confirmed by **Spike S5** (Sprint 0).
- (−) `withStructuredOutput` sensitivity to the Zod version → pin `~3.25.67` (**Spike S1**, ADR note).

## Rejected alternatives

- **AgentExecutor (legacy)** — less control over state/loops; being phased out of the ecosystem.
- **A custom agentic loop without a framework** — more plumbing, loss of ready integrations (Langfuse CallbackHandler).
- **Python + LangGraph** — doesn't match the working project's stack.
