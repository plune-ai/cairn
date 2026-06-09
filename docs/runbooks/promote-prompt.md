# Runbook: promoting a prompt (human gate)

> **Status:** stub (S5, task 5.5) · Context: [`../architecture/self-improvement.md`](../architecture/self-improvement.md)

## When

After the experiment ([`run-experiment.md`](./run-experiment.md)), when there is evidence of improvement.

## Decision rule (gate)

A candidate **passes** IF, across the **entire** dataset:
1. the target metric (average `runs_green` OR `grounding`) is improved by **≥ THRESHOLD** (default +0.05), **AND**
2. **no guardrail score regresses** beyond tolerance (default −0.02):
   guardrails = `compiles`, `locator_quality`, `methodology_adherence`, `grounding`.

> Refine the thresholds after the first dataset (they depend on the baseline variance — Spike S4).

## Procedure

1. Open Langfuse Experiments → compare candidate vs production.
2. Check against the decision rule above.
3. **Pass:** move the `production` label to the candidate version (= deploy). Record it in the prompt spec's notes (old/new version, deltas).
4. **Fail:** leave it as `candidate`/reject; note the reason; iterate.

## Rollback

Move the `production` label back to the previous version. The bot will pick it up on the next `getPrompt`.

## Safety invariant

**No auto-deployment of prompts.** Only a human moves the `production` label, reading the evidence.
