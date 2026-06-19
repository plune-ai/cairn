# Architecture Overview

## Problem

A QA engineer needs to quickly produce quality UI tests for an application: open a page
(often behind a logged-in session), understand what's on it, and write methodologically grounded
test cases and runnable code. This is repetitive, labor-intensive work whose quality depends on
discipline and experience.

## Solution (one sentence)

An autonomous agent that **observes** a page (screenshot + ARIA snapshot), **reasons**
(an LLM with a methodology skill), **acts** (generates `@playwright/test` code), **self-validates**
(runs the generated tests), and **improves itself** through an observable Langfuse loop.

## What it is NOT

- Not a replacement for a QA engineer — it's an assistant tool with a human in the improvement loop.
- Not "tests that fix themselves" — the **bot** improves itself (its prompts/heuristics), not the already-generated tests.
- (For now) not a crawler — the MVP works with **a single page** (application-graph traversal is a future ADR).

## Context and the key finding

The testing methodology already exists in the author's own repository `AZANIR/qa-skills`
(`qa-testcase-from-ui`, `qa-manual-test-designer` per ISO/IEC/IEEE 29119-4, `qa-playwright-ts-writer` per POM).
So the bot = **an autonomous runtime + a self-improvement loop around an already-existing methodology**.
The methodology is ported into versioned Langfuse prompts (ADR-0008, ADR-0004).

## C4 — Level 1 (Context)

```
        ┌──────────────┐       cases + Playwright code     ┌──────────────────┐
        │  QA engineer │ ───────────────────────────────▶ │ Working application│
        │  (operator)  │ ◀── checklist / session / promote │   (under test)    │
        └──────┬───────┘                                   └──────────────────┘
               │ runs / curates
               ▼
        ┌──────────────────────────┐   traces/scores   ┌──────────────┐
        │      QA Explorer Bot      │ ────────────────▶ │   Langfuse   │
        │  (CLI + library, async    │ ◀── prompts/datasets │ (observ.+eval)│
        │     pipeline)             │                   └──────────────┘
        └─────┬───────────────┬─────┘
              │ vision/reason │ browse/act
              ▼               ▼
       ┌─────────────┐  ┌──────────────────────┐
       │ Anthropic   │  │ Browser (Playwright)  │
       │ Claude      │  │ lib + @playwright/cli │
       └─────────────┘  └──────────────────────┘
```

## C4 — Level 2 (Container, inside the bot)

```
CLI / Library API
      │
      ▼
Plain async pipeline (runExploreGraph) ────────────────────────────────┐
  loadSession → observe → identifyElements → [consumeChecklist] →       │
  designTestCases → [codeless? stop] → generateCode → runRepairLoop      │
  (validate ⇄ repair, keep-best) → score                                │
      │            │              │            │           │            │
      ▼            ▼              ▼            ▼           ▼            ▼
 SessionStore  PageObserver  TestCaseDesigner TestCodegen TestValidator  Judge/Eval
      │            │              │            │           │            │
      └────────────┴──────────────┴────────────┴───────────┘            │
                            BrowserGateway                               │
                     (playwright-lib | playwright-cli)                   │
                                                                         ▼
   PromptRegistry (Langfuse + local fallback)  ·  Telemetry (root span + callbackHandler)  ·  ArtifactStore (./runs)
```

## High-level flow of a single run

1. **loadSession** — bring up `storageState` (cookies+localStorage) in the browser.
2. **observe** — navigation + screenshot + ARIA snapshot + element refs → `PageStudy`.
3. **identifyElements** — Opus (vision) ranks interactive elements and semantics.
4. **consumeChecklist** *(opt.)* — narrow scope to the operator's checklist.
5. **designTestCases** — Opus per the 29119-4 methodology → structured `TestCase[]`.
6. **generateCode** — Sonnet → `@playwright/test` (POM + fixtures + getByRole + aria assertions).
7. **validate / repair** — run via playwright-lib; on failure — a bounded self-repair loop.
8. **score** — deterministic scorers + LLM judges → Langfuse; everything lands in `./runs/<id>`.

Each run is one Langfuse trace (root span via `startActiveObservation`); each stage's LLM call is a nested generation linked to a prompt version via the callback handler.

## Technology pillars (more detail — in the corresponding ADRs)

- **Agent:** plain async pipeline (`runExploreGraph`) over `BrowserGateway` + `StructuredInvoke` seams — ADR-0001 / ADR-0013.
- **LLM:** multi-provider (Anthropic default + OpenRouter/DeepSeek/Qwen as an economical alternative), tier×provider mapping, vision optional — ADR-0002.
- **Browser:** hybrid lib(PRIMARY)+cli(SECONDARY) behind `BrowserGateway` — ADR-0003.
- **Prompts:** versioned in Langfuse + local fallback — ADR-0004.
- **Output:** `@playwright/test` POM — ADR-0005.
- **Observability:** Langfuse v5 (OTel), **self-hosted on the user's server**; judges are SDK-side — ADR-0006.
- **Packaging:** one layered npm package — ADR-0007.
- **Methodology:** ported from qa-skills — ADR-0008.

Composition details — [`module-map.md`](./module-map.md); the graph — [`state-machine.md`](./state-machine.md);
the improvement loop — [`self-improvement.md`](./self-improvement.md).
