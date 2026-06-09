# Runbook: curating failures into a dataset

> **Status:** stub (S5, task 5.3) · Context: [`../architecture/self-improvement.md`](../architecture/self-improvement.md)

## Goal

Turn real low-quality runs into regression examples on which we measure future versions of the bot.

## Surfacing (automatic)

A triage step/query selects low-score traces: `runs_green < 0.7` **OR** `grounding < 0.6`.

## Promotion into the dataset (human)

1. In the Langfuse UI, review the selected traces.
2. For the worthy ones — create an item in `bot-regression-v1`:
   ```
   input:  { url | fixtureHtml, checklist?, sessionRef }
   expected_output?: golden TestCase[] / notes on what should have come out
   metadata: { difficulty, area, reason }
   ```
3. For fixture pages — add/verify the **goldens** (hand-written, by the QA owner). The goldens are
   the single source of truth; they also serve as the integration corpus in `tests/fixtures`.

## Dataset hygiene

- Version the dataset; don't delete old items (the regression must catch the return of old bugs).
- Balance the difficulty (easy/medium/hard) so the metric doesn't saturate.

## What NOT to do

- Don't put flaky examples into the dataset without a label (they poison the metric; see Spike S4).
