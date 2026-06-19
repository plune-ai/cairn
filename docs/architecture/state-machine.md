# Agent Pipeline (plain async pipeline, formerly LangGraph)

> **Replaced in 0.4.0 (ADR-0013):** the `StateGraph` from `@langchain/langgraph` was removed;
> `buildExploreGraph` became `runExploreGraph(deps, init): Promise<ExploreOutcome>` — a plain sequence
> of awaited stage calls over the same service seams (`BrowserGateway`, `StructuredInvoke`).
> Langfuse tracing is rebound at the LLM layer via a root span (`startActiveObservation`) + the callback
> handler threaded into each LLM call by `RoleRouter`.

## State (`agent/graph.ts`)

The former `Annotation.Root` (`ExploreState`) is now a plain `ExploreOutcome` interface:

```ts
export interface ExploreOutcome {
  // inputs carried through
  targetUrl: string;
  sessionName?: string;
  checklist?: Checklist;
  // accumulated results
  study?: PageStudy;
  elements: ElementRef[];
  testCases: TestCase[];
  suite?: GeneratedSuite;
  validation?: ValidationReport;
  // control
  attempts: number;
  errors: string[];
  runId: string;
  // telemetry
  last_trace_id?: string;
}
```

## Pipeline stages

| Stage | What it does | Vision | Structured output |
|-------|-------------|:------:|-------------------|
| `loadSession` | Bring up `storageState` into the gateway session (or a clean start) | – | – |
| `observe` | Navigation; screenshot + ariaSnapshot + element refs → `study` | – | – |
| `identifyElements` | reasoning+vision tier: screenshot+aria → ranked elements + semantics | ✅ opt.¹ | `ElementsSchema` |
| `consumeChecklist` | If a checklist exists → coverage targets; narrow scope | – | `CoverageTargetsSchema` |
| `designTestCases` | **Opus**: methodology prompt → `TestCase[]` (29119-4) | opt. | `TestCaseSchema` |
| `generateCode` | **Sonnet**: POM prompt → `@playwright/test` + `.aria.yml` | – | `SuiteSchema` |
| `validate / repair` | Run the suite via playwright-lib; on failure — `runRepairLoop` (bounded, keep-best) | – | `SuiteSchema` |
| `score` | Deterministic scorers + LLM judge → Langfuse; persist artifacts | judge opt. | judge schema |

> **Models per stage = tier (ADR-0002), not a specific provider.** The default profile is `anthropic`
> (Opus reasoning/vision, Sonnet bulk, Haiku judge); the economical one is `openrouter` (DeepSeek/Qwen). The
> `makeModel(tier)` factory hides the choice.
>
> ¹ **Vision is optional:** if the reasoning-tier model has no vision (e.g. DeepSeek), `identifyElements`
> falls back to **aria-only** mode — lower quality on visually-complex pages, but full functionality.

## Flow (control)

```
observe → identifyElements
               │
     checklist?│
   ┌───────────┴───────────┐
  yes                       no
   │                         │
 consumeChecklist             │
   └───────────┬─────────────┘
               ▼
        designTestCases
               │
       codeless? (design-only mode)
   ┌───────────┴───────────┐
  yes                       no
   │                         │
  stop                 generateCode
                             │
                      runRepairLoop (validate ⇄ repair, keep-best)
                             │
                           score
                             │
                           done
```

- `runRepairLoop` is the same helper used by `runAutomate`/`runDesign` — no inline duplicate.
- `MAX_REPAIR` (from `Config`, default 2) bounds the loop.
- **Backend split:** observe/identifyElements can go to `playwright-cli` (token-efficient);
  `validate` ALWAYS goes to `playwright-lib` (it runs the tests). The gateway routes `runTests`→lib
  regardless of the observe config (ADR-0003).

## Tracing

```ts
await telemetry.runInTrace(runId, async (span) => {
  // RoleRouter threads callbackHandler into every LLM call config
  const out = await runExploreGraph(deps, init);
  await scoreRun(span, out);
});
```

→ each stage's LLM call = a nested Langfuse generation under a single root span; each links a prompt
version, so a regression can be attributed to a specific change (see [`self-improvement.md`](./self-improvement.md)).

## Stage design principles

- One stage — one responsibility; stages do not call one another.
- All the "smart" work goes through services (`design/`, `codegen/`, `observe/`); stages only orchestrate.
- Schemas for structured output live next to their stage; zod is pinned (Spike S1).
