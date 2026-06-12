# Runbook: running an experiment (candidate vs production)

> **Status:** stub (S5, task 5.4) · Context: [`../architecture/self-improvement.md`](../architecture/self-improvement.md)

## Goal

Prove (or disprove) that a new prompt version is better than production, on the regression dataset — **before** promotion.

## Prerequisites

- The `bot-regression-v1` dataset with ≥10 items (see [`curate-dataset.md`](./curate-dataset.md)).
- A new prompt version in Langfuse with the label `candidate`.

## Run

```bash
cairn experiment \
  --dataset bot-regression-v1 \
  --prompt qa-testcase-from-ui \
  --prompt-version candidate \
  --stage design        # per-stage: design | codegen | full
```

→ `dataset.runExperiment({ task, evaluators })`; `task` is pinned to the candidate version;
`evaluators` = deterministic scorers + LLM judges.

## Reading the results

The Langfuse Experiments UI: compare the candidate vs production aggregates by scorer.
The decision follows the [`promote-prompt.md`](./promote-prompt.md) decision rule.

## Notes

- **Per-stage** is cheaper and attributes regressions more precisely than the full pipeline.
- Record the runId/experiment name in the prompt spec's notes.
