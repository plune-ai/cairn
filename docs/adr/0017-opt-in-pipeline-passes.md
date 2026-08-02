# ADR-0017: The pipeline grows by opt-in passes, and a flag-off run is byte-identical

- **Status:** Accepted
- **Date:** 2026-06-22 (the rule was set by `--critique`, `--flow`, `--setup`, `--gaps` landing together) · extended 2026-06-29 (`--goal`), 2026-06-30 (`--screencast`)
- **Decision in code:** `src/design/critique.ts`, `src/flow/`, `src/eval/{coverage,gap-cases}.ts`, `src/agent/graph.ts`, `src/cli/index.ts`
- **Applies from:** 0.5.0 · **Issues:** #82, #59, #60, #61, #63, #94 · **PRs:** #83, #86, #87, #88, #114, #130
- **Relationship to prior ADRs:** governs how ADR-0013's plain async pipeline is extended. The stage order itself is ADR-0013; this is the rule for adding to it.

## Context

Dropping LangGraph (ADR-0013) left a linear async pipeline that is easy to read and easy to extend — which
is the danger. Six capabilities queued up at once, each of which *could* have been made the new default:

| Flag | What it adds |
|---|---|
| `--critique` | a design-time self-critique pass: prune trivial/contradictory/unverifiable cases, top up under-represented 29119-4 techniques |
| `--flow` | crawl the in-app link graph and design journeys spanning ≥2 pages |
| `--setup` | turn a journey's prose preconditions into structured, runnable setup |
| `--gaps` | suggest cases for the untested surface the coverage view exposes |
| `--goal` | bias observation and planning toward a natural-language goal |
| `--screencast` | record a `.webm` per scenario during validation, with step chapters |

Turning any of them on by default would have raised the cost and latency of every run, changed the shape of
every artifact, and made regressions impossible to attribute — six new LLM passes cannot be A/B'd against a
baseline that keeps moving. It would also have broken the thing the self-improvement layer (ADR-0006) depends
on: comparing runs.

## Decision

**A new capability enters as an opt-in pass, default OFF, and a run without its flag produces a
byte-identical artifact to the run before the pass existed.**

The rules, in the order they bind:

1. **Default off, one flag.** The flag appears on the modalities it applies to (`explore`, `design`, or
   `automate`) and nowhere else. `--goal` and `--max-pages` take a value; the rest are booleans.
2. **No artifact differs without the flag.** Not "roughly the same" — byte-identical. `--goal` is the sharpest
   case: `formatGoal("")` yields `""`, so the prompts are literally unchanged when no goal is passed.
3. **Each pass is bounded.** `--critique` is exactly one LLM call. `--flow` is bounded by `--max-pages`
   (default 3). `--gaps` designs for the top-N untested elements only. Cost is a design input, not an outcome.
4. **A pass hangs off a seam, not off the middle of a stage.** Each is gated by its own dependency
   (`deps.critique`, `deps.flow`, `deps.setup`, …) so the stage it follows stays testable without it.
5. **Best-effort passes never sink a run.** Journey design and screencast recording are best-effort: a
   recorder or IO failure is logged, and the run's primary output still lands.
6. **A read-only view may ship on by default; a generated artifact may not.** The coverage view is the one
   deliberate exception — `computeCoverage` is a pure set difference over data the run already has (observed
   interactive surface and transitions, minus what any case or journey references), it costs no LLM call, and
   it changes no generated file. It is emitted on **every** run into `report.json` and `report.md`. The
   *cases* that fill those gaps are what `--gaps` gates.
7. **Safety rules are not opt-in.** The flow crawler never follows destructive links (log out, delete), stays
   in-origin, and dedupes revisits — with or without any flag. `--setup` downgrades an `api-seed` precondition
   with no concrete endpoint to `manual` rather than fabricating a seeding call. These are properties of the
   pass, not options on it.

## Consequences

- **Regressions stay attributable.** A baseline run is still the same run it was six features ago, so
  Langfuse experiments and dataset comparisons (ADR-0006) remain meaningful.
- **Cost is opt-in too.** Someone running `cairn explore --url …` in 0.6.0 pays what they paid in 0.4.0.
- **The flag surface grows, and is locked by a test.** The CLI `--help` snapshot fails on any accidental
  change to the surface — which is the price of this rule and worth paying.
- **Discovery gets harder.** Six useful capabilities are invisible unless the user reads the docs. The
  coverage view partly compensates: it ships on by default and shows the user what they are not testing,
  which is the natural prompt to reach for `--gaps`.
- **Defaults can still be revisited, once.** Promoting a pass to on-by-default is itself a decision that
  changes the artifact for everyone, so it needs its own ADR, not a quiet flip.

## Rejected alternatives

- **Make the good passes default and add `--no-*` opt-outs.** Every existing user's cost, latency and artifact
  shape would have changed under them, and the self-improvement baseline would have moved six times in ten days.
- **A single `--deep` / preset flag bundling several passes.** Hides which pass caused a change and makes each
  one impossible to evaluate on its own. Presets are worth revisiting once the individual passes have evidence.
- **Config-file-only switches.** The passes are per-run decisions ("crawl this app's flows", "record this
  review"), not per-project settings; a config key would have made a per-run choice sticky.
- **Gating the coverage view behind `--gaps` too.** It costs nothing, generates nothing and is the single most
  useful default addition of the six. Hiding it would have been consistency for its own sake.
