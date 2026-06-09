# Agent State Machine (LangGraph)

The agent is a `StateGraph` from `@langchain/langgraph` v1 (ADR-0001). Each node is a small pure function
`(state) => Promise<Partial<state>>`. Vision and structured output happen *inside* the nodes
via `ChatAnthropic` + `.withStructuredOutput(zodSchema)`.

## State (`agent/state.ts`)

```ts
import { Annotation } from "@langchain/langgraph";

export const ExploreState = Annotation.Root({
  // inputs
  targetUrl:   Annotation<string>,
  sessionName: Annotation<string | undefined>,
  checklist:   Annotation<Checklist | undefined>,
  // working memory
  study:       Annotation<PageStudy | undefined>,
  elements:    Annotation<ElementRef[]>({ default: () => [], reducer: (_, n) => n }),
  testCases:   Annotation<TestCase[]>({ default: () => [], reducer: (_, n) => n }),
  suite:       Annotation<GeneratedSuite | undefined>,
  validation:  Annotation<ValidationReport | undefined>,
  // control
  attempts:    Annotation<number>({ default: () => 0, reducer: (_, n) => n }),
  errors:      Annotation<string[]>({ default: () => [], reducer: (a, n) => a.concat(n) }),
  runId:       Annotation<string>,
});
export type S = typeof ExploreState.State;
```

## Nodes

| Node | What it does | Vision | Structured output |
|------|-----------|:------:|-------------------|
| `loadSession` | Bring up `storageState` into the gateway session (or a clean start) | – | – |
| `observe` | Navigation; screenshot + ariaSnapshot + element refs → `study` | – | – |
| `identifyElements` | reasoning+vision tier: screenshot+aria → ranked elements + semantics | ✅ opt.¹ | `ElementsSchema` |
| `consumeChecklist` | If a checklist exists → coverage targets; narrow scope | – | `CoverageTargetsSchema` |
| `designTestCases` | **Opus**: methodology prompt → `TestCase[]` (29119-4) | opt. | `TestCaseSchema` |
| `generateCode` | **Sonnet**: POM prompt → `@playwright/test` + `.aria.yml` | – | `SuiteSchema` |
| `validate` | Run the suite via playwright-lib; classify | – | – |
| `repair` | On failure — code+errors back to the model → patch the suite | – | `SuiteSchema` |
| `score` | Deterministic scorers + LLM judge → Langfuse; persist artifacts | judge opt. | judge schema |

> **Models per node = tier (ADR-0002), not a specific provider.** The default profile is `anthropic`
> (Opus reasoning/vision, Sonnet bulk, Haiku judge); the economical one is `openrouter` (DeepSeek/Qwen). The
> `makeModel(tier)` factory hides the choice.
>
> ¹ **Vision is optional:** if the reasoning-tier model has no vision (e.g. DeepSeek), `identifyElements`
> falls back to **aria-only** mode (only the text ARIA snapshot, no screenshot) — lower quality on
> visually-complex pages, but full functionality. The `supportsVision` flag controls the mode.

## Graph (edges)

```
__start__
   │
   ▼
loadSession ─▶ observe ─▶ identifyElements
                              │
                    checklist?│
                  ┌───────────┴───────────┐
                 yes                       no
                  │                         │
            consumeChecklist                │
                  └───────────┬─────────────┘
                              ▼
                       designTestCases ─▶ generateCode ─▶ validate
                                                             │
                                              routeAfterValidate (conditional)
                          ┌──────────────────────┬───────────┴───────────┐
                     all green            failures & attempts<MAX   failures & attempts≥MAX
                          │                       │                       │
                          ▼                       ▼                       ▼
                        score                  repair ──▶ validate      score
                          │                                               │
                          ▼                                               ▼
                       __end__                                         __end__
```

- `routeAfterValidate` returns `'repair' | 'score'` and increments `attempts`.
- `MAX_REPAIR` — from `Config` (default 2) — bounds the self-repair loop.
- **Backend split:** `observe`/`identifyElements` can go to `playwright-cli` (token-efficient);
  `validate` ALWAYS goes to `playwright-lib` (it runs the tests). The gateway routes `runTests`→lib
  regardless of the observe config (ADR-0003).

## Tracing

```ts
await graph.invoke(input, {
  callbacks: [callbackHandler],            // @langfuse/langchain
  runName: "exploration",
  metadata: { runId, backend, promptVersions: { designer, codegen, elements } },
});
```

→ each node's LLM call = a nested Langfuse generation under a single trace; each links a prompt version,
so a regression can be attributed to a specific change (see [`self-improvement.md`](./self-improvement.md)).

## Node design principles

- One node — one responsibility; nodes do not call one another.
- All the "smart" work goes through services (`design/`, `codegen/`, `observe/`); nodes only orchestrate.
- Schemas for structured output live next to their node; zod is pinned to `~3.25.67` (Spike S1).
