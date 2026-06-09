# Module Map

One layered npm package `@plune-ai/lex-bot` (ADR-0007). Layer boundaries = directories + barrel exports +
ESLint `no-restricted-imports`. **Browser backends are imported ONLY through `browser/gateway.ts`.**

## `src/` structure

```
src/
├─ index.ts        # public library API (runExploration, types)
├─ config/         # Config: env/file → typed AppConfig (zod)
├─ telemetry/      # OTel + Langfuse bootstrap, flush, CallbackHandler
├─ llm/            # model factory (Opus/Sonnet/Haiku), vision helpers
├─ prompts/        # PromptRegistry (Langfuse + local fallback) + local/*.md|json
├─ browser/
│  ├─ gateway.ts   # BrowserGateway interface + factory(config)
│  ├─ types.ts     # Observation, ElementRef, ActResult, SessionHandle
│  └─ backends/
│     ├─ playwright-lib.ts   # PRIMARY: in-process `playwright`
│     └─ playwright-cli.ts   # SECONDARY: wrapper over `@playwright/cli`
├─ observe/        # PageObserver: snapshot+screenshot+element extraction
├─ session/        # SessionStore: storageState load/save/validate
├─ checklist/      # ChecklistIngestor: md/structure → ChecklistItem[]
├─ design/         # TestCaseDesigner: methodology → TestCase[]
├─ codegen/        # TestCodegen: TestCase[] → @playwright/test + .aria.yml
├─ validate/       # TestValidator: run tests, classify
├─ agent/
│  ├─ state.ts     # ExploreState Annotation.Root
│  ├─ graph.ts     # StateGraph (nodes+edges), compile()
│  ├─ nodes/       # one file = one node
│  └─ tools/       # tool() wrappers (when the model needs direct access)
├─ eval/
│  ├─ judge.ts     # LLM-as-judge evaluators
│  ├─ scorers.ts   # deterministic scorers
│  └─ experiment.ts# DatasetExperimentRunner
├─ artifacts/      # ArtifactStore: ./runs/<id>/
└─ cli/            # CLI (commander)
```

## Module table

| Module | Responsibility | Key interface | Depends on |
|--------|------------------|--------------------|--------------|
| **Config** | Load + validate config | `loadConfig(): AppConfig` | zod |
| **Telemetry** | Bootstrap OTel/Langfuse + flush | `initTelemetry(cfg): { langfuse, callbackHandler, shutdown() }` | `@langfuse/otel`,`@langfuse/client`,`@langfuse/langchain`,`@opentelemetry/sdk-node` |
| **llm** | Provider-agnostic model factory by tier (Anthropic \| OpenRouter) + vision helper | `makeModel(tier): BaseChatModel`; `imageBlock(b64,mime)`; `supportsVision(tier)` | `@langchain/anthropic`,`@langchain/openai`,`@langchain/core` |
| **PromptRegistry** | Versioned prompts + fallback | `getPrompt(name, vars?): Promise<CompiledPrompt>` | `@langfuse/client`, local files |
| **BrowserGateway** | Abstraction over backends | `observe`/`act`/`session`/`runTests`/`close` | backends, session, Config |
| ↳ playwright-lib | PRIMARY (+`runTests`) | `implements BrowserBackend` | `playwright` |
| ↳ playwright-cli | SECONDARY (observe/act) | `implements BrowserBackend` | `@playwright/cli` |
| **PageObserver** | Page → `PageStudy` | `capture(gateway,url): Promise<PageStudy>` | BrowserGateway |
| **SessionStore** | storageState lifecycle | `load`/`save`/`isValid` | fs, playwright types |
| **ChecklistIngestor** | Checklist → typed items | `ingest(pathOrText): Promise<Checklist>` | md-parser, zod |
| **TestCaseDesigner** | Methodology → cases | `design(input): Promise<TestCase[]>` | llm, PromptRegistry |
| **TestCodegen** | Cases → `@playwright/test` | `emit(cases, study): GeneratedSuite` | llm, PromptRegistry |
| **TestValidator** | Run + classify | `validate(suite): Promise<ValidationReport>` | BrowserGateway(lib), artifacts |
| **Agent (graph)** | Orchestrate the loop | `buildGraph(deps)`; `runExploration(input)` | everything above |
| **Judge/Eval** | LLM judge + scorers → scores | `scoreRun(span, outputs)`; `evaluators[]` | llm, Telemetry |
| **DatasetExperimentRunner** | Prove an improvement | `runExperiment(datasetName, taskVersion)` | `@langfuse/client`, eval |
| **ArtifactStore** | Local run artifacts | `openRun(): RunWriter` | fs |
| **CLI** | Operator entry point | `explore`/`observe`/`validate`/`experiment`/`prompts` | commander, agent |

## Import rule (enforced)

1. Only `browser/gateway.ts` imports `browser/backends/*`.
2. Nodes (`agent/nodes/*`) do not import one another — only services.
3. `eval/*` and `prompts/*` do not import `agent/*` (we keep them reusable and separately testable).

> Violations of these rules should be caught by ESLint `no-restricted-imports` — add the config in Sprint 0.
