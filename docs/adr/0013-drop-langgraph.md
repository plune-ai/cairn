# ADR-0013: Drop `@langchain/langgraph`; rebind telemetry at the LLM layer; make Ink/React optional

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decision in code:** `src/agent/graph.ts`, `src/telemetry/index.ts`, `src/tui/index.ts`, `package.json`
- **Applies from:** 0.4.0
- **Supersedes (partially):** ADR-0001 (LangGraph orchestration layer only; TypeScript + LangChain-core LLM layer retained), ADR-0009 (Ink/React moved to optional dependencies)

## Context

By 0.3.x the `@langchain/langgraph` dependency was the sole importer of its package in the codebase —
`src/agent/graph.ts` used `StateGraph` / `Annotation.Root` / `addConditionalEdges`; the Sprint 0 spike
script (`scripts/spike-s5-langfuse.ts`) also imported it. No other file ever touched `langgraph`.

The actual value LangGraph added here was minimal:

- **State channels** (`Annotation.Root`) — trivial reducers (`(_, n) => n` or `a.concat(n)`); the
  underlying data is a plain object anyway.
- **Graph topology** — a linear + one conditional edge; equivalent to `if/else` and a `while` loop.
- **Built-in checkpointer / streaming** — durability was already hand-rolled via the `onStudy` /
  `onTestCases` callbacks; streaming uses the same callbacks.
- **Telemetry propagation** — `graph.invoke({ callbacks:[callbackHandler] })` was the hook, but
  `RoleRouter` can thread the callback handler into each LLM call directly.

Meanwhile `@langchain/langgraph` is a fast-moving peer whose major changes cause periodic breakage and
whose full graph primitives go largely unused.

Similarly, Ink / React were in `dependencies`, so every `npm install @plune-ai/cairn` pulled them even
when the operator only wanted the library API or the flag-based CLI.

## Decision

1. **Remove `@langchain/langgraph`** from `dependencies` and from the codebase entirely. Rewrite
   `buildExploreGraph` (a `StateGraph`) as `runExploreGraph(deps, init): Promise<ExploreOutcome>` —
   a plain async function with sequential `await` calls for each stage, a shared `ExploreOutcome` object
   (plain interface, no `Annotation.Root`), and the existing `runRepairLoop` helper for the
   generate⇄validate⇄repair portion (removing the inline keep-best duplicate). The stage seams
   (`BrowserGateway`, `StructuredInvoke`) are untouched.

2. **Rebind Langfuse telemetry at the LLM layer.** A lazy root span (`startActiveObservation` from
   `@langfuse/tracing`) wraps each `runExploreGraph` call via `telemetry.runInTrace(runId, …)`.
   `RoleRouter` threads the `@langfuse/langchain` `CallbackHandler` into the `config` of every LLM
   invocation — so each stage's LLM call becomes a nested Langfuse generation under the root span,
   preserving the full trace structure without requiring LangGraph as the propagation vehicle.

3. **Move `ink`, `react`, `ink-select-input`, `ink-text-input`, `ink-spinner` from `dependencies` to
   `optionalDependencies`.** The TUI path lazy-imports them and falls back gracefully (prints help) when
   they are absent. Embedders and CI installs now skip them by default.

4. **Delete `scripts/spike-s5-langfuse.ts`** and its npm script (`spike:s5-langfuse`) — the spike is
   closed and the langgraph import it contained is no longer valid.

## Why `@langchain/core` is retained

`@langchain/core` provides the `BaseChatModel` abstraction and `withStructuredOutput()` that lets the
LLM factory (`llm/routing.ts`) stay provider-agnostic (Anthropic / OpenRouter / Groq) without a custom
shim. This dependency has no graph machinery and is stable across the LangChain ecosystem.

## Consequences

- **(+) Reduced footprint.** One fewer fast-moving external dependency; the `langgraph` peer breakage
  vector is eliminated. Ink/React are opt-in, saving install weight for library users.
- **(+) Simpler mental model.** The pipeline is now plain TypeScript `await` calls — no graph
  compilation step, no `StateGraph`, no `Annotation.Root` to explain to new contributors.
- **(+) Domain nodes untouched.** The stage functions (`observe`, `identifyElements`, `designTestCases`,
  etc.) in `src/agent/nodes/` are unchanged — the seams (`BrowserGateway`, `StructuredInvoke`) absorb
  the orchestrator replacement.
- **(−) No built-in checkpointer.** Durability across crashes was never enabled, but LangGraph would
  have provided it. Still hand-rolled via run artifacts in `./runs/<id>/`.
- **(−) No built-in graph streaming.** The `onStudy` / `onTestCases` / `onProgress` callbacks already
  cover this use-case and are the public API contract.

## Note on `vercel-labs/agent-browser`

The `agent-browser` package (Vercel Labs) was evaluated as a possible future-proof browser-as-agent
integration but deferred. It could be added later as an optional peer behind `BROWSER_BACKEND=agent`
without touching this pipeline.
