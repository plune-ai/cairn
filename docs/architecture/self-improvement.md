# The Self-Improvement Loop (the heart of the product)

The bot improves **itself** — its prompts, element ranking, design heuristics — and **not**
the already-written tests. The substrate is Langfuse v5 (ADR-0006). The principle: *everything is measured
automatically, and changes that affect behavior pass a human gate.*

## Data flow

```
   ┌──────────────────────────────────────────────────────────────────┐
   │ (a) COLLECT: each runExploration → 1 Langfuse trace               │
   │     nested generations per node, link to the prompt version       │
   └───────────────────────────┬──────────────────────────────────────┘
                               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ (b) SCORING (automatic): deterministic scorers + LLM judges        │
   │     compiles · runs_green · flaky · locator_quality · grounding…   │
   └───────────────────────────┬──────────────────────────────────────┘
                               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ (c) CURATION (human gate): low-score traces → dataset items        │
   │     surfacing — automatic; promotion into the dataset — operator   │
   └───────────────────────────┬──────────────────────────────────────┘
                               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ (d) PROMPT ITERATION (human): new version in Langfuse, label=candidate│
   └───────────────────────────┬──────────────────────────────────────┘
                               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ (e) EXPERIMENT (automatic run): dataset.runExperiment              │
   │     candidate vs production on the regression dataset             │
   └───────────────────────────┬──────────────────────────────────────┘
                               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ (f) PROMOTION (human, on evidence): move label=production         │
   │     deploy = move label · rollback = move back                    │
   └──────────────────────────────┬───────────────────────────────────┘
                                  └──▶ back to (a)
```

## (a) What is traced (automatic)

Via the LangChain `CallbackHandler`. Trace metadata: `runId, targetUrl, backend, checklistHash,
promptVersions{designer,codegen,elements}, modelTiers`. Large artifacts (tests, study.json,
validation report) go locally via `ArtifactStore` (`./runs/<id>`); in Langfuse — a link + scores.

## (b) Scores and judges

**Deterministic (objective, automatic):**

| Score | What it measures |
|-------|----------|
| `compiles` | the suite parses with `tsc` (0/1) |
| `runs_green` | % of generated tests that pass on the first validation |
| `flaky` | result variation across N reruns |
| `locator_quality` | % of `getByRole`/`getByLabel` vs CSS/xpath |
| `aria_assertion_present` | presence of an ARIA snapshot assertion (0/1) |
| `checklist_coverage` | % of checklist items covered by ≥1 case |

**LLM-as-judge (subjective; the judge prompts are themselves versioned) — executed SDK-side:**

> We call the judge model ourselves in `eval/judge.ts` (judge-tier per ADR-0002: Anthropic Haiku OR a cheap
> OpenRouter model) and write scores via the SDK. We do **NOT** rely on Langfuse server-managed evaluators
> → the loop is portable to a self-hosted instance (ADR-0006) and provider-agnostic.


| Score | What it measures |
|-------|----------|
| `test_case_quality` | completeness/clarity of the cases |
| `methodology_adherence` | whether the cases reflect the 29119-4 techniques from the skill |
| `grounding` | whether the tests target elements that are actually present (catches hallucinated locators) |

Writing: `langfuse.score.observation(span, {name, value, comment})` / `score.create`.

## (c) Curating failures → dataset (human-in-the-loop)

A triage step queries low-score traces (`runs_green < 0.7` OR `grounding < 0.6`).
The operator **promotes** selected ones into the `bot-regression-v1` dataset in the Langfuse UI:
item = `{ input: {url|fixtureHtml, checklist?, sessionRef}, expected_output?: golden TestCase[]/notes }`.
Surfacing is automatic; promotion is a human quality gate. Goldens for fixture pages are written by the QA owner;
they also serve as the integration corpus in `tests/fixtures`.

## (d) Prompt versioning

Prompts live in Langfuse Prompt Management, runtime-fetched via `getPrompt(name, {label:'production'})`
+ a **mandatory local fallback** (the bot works offline / on first start). Editing = a new version;
prod doesn't change until the label is moved.

## (e) Experiments

`DatasetExperimentRunner` wraps `dataset.runExperiment({ name, task, evaluators })`:
- `task` = a run of a **substage** (per-stage: design-only / codegen-only), pinned to the candidate prompt version;
- `evaluators` = deterministic scorers + LLM judges.

Comparison of prod vs candidate — in the Experiments UI.

## (f) Decision rule (promotion gate)

A candidate **passes** if:
1. it improves the target metric (average `runs_green` or `grounding`) by **≥ threshold**, AND
2. it does **not regress** any guardrail score beyond tolerance,
across the **entire** regression dataset.

Pass → the operator moves the `production` label. Fail → reject/iterate. Details — [`../runbooks/promote-prompt.md`](../runbooks/promote-prompt.md).

## Automatic vs human

| Step | Automatic | Human |
|------|:-------:|:------:|
| Tracing of every run | ✅ | – |
| Deterministic + LLM-judge scores | ✅ | (the judge prompt is written by a human) |
| Surfacing failures | ✅ | – |
| Trace → dataset item | – | ✅ |
| Goldens | – | ✅ |
| New prompt version | – | ✅ |
| Experiment candidate vs prod | ✅ | – |
| Promotion of the production label | – | ✅ (reads the experiment evidence) |

No auto-deployment of prompts — the loop stays safe, but all measurements are automated.
