# ADR-0020: An LLM verdict is an untrusted input; only self-created data is disposable

- **Status:** Accepted
- **Date:** 2026-06-23
- **Decision in code:** `src/safety/guardrails.ts`, `src/eval/pilot.ts`, `src/agent/index.ts`, `src/flow/setup.ts`, `prompts/local/pilot-review`
- **Applies from:** 0.5.0 · **Issue:** #91 (BORROW-04) · **PR:** #100
- **Relationship to prior ADRs:** constrains ADR-0006's judge/Pilot layer and ADR-0017's `--setup` pass. Neither is optional; these rules apply on every run.

## Context

Two capabilities had just landed or were about to, and both created a class of failure that testing cannot
catch after the fact.

**The Pilot verdict.** ADR-0006 gives Cairn an LLM supervisor that reviews a run and returns a verdict. A
"pass" is the input to everything downstream — scores, experiments, whether a suite is considered good. The
verdict was accepted at face value. The specific failure it invites is well known and cheap to produce: the
model reports success naming an entity ("created the *Acme Corp* record") that the run never touched. Nothing
checked. A false pass is worse than a false fail, because a false fail gets investigated.

**Journey setup.** `--setup` (ADR-0017) turns a journey's prose preconditions into runnable setup. Some
preconditions are phrased as deletions — "no existing draft", "an empty cart". At setup time, by definition,
nothing has been created yet, so any deletion at that point necessarily targets **pre-existing data** — the
user's real data, in the app the user pointed Cairn at.

Both had to be closed before any stateful or destructive automation went further, not after.

## Decision

**Two rules, both unconditional, both pure functions in `src/safety/guardrails.ts`.**

### 1. A verdict that names an entity must prove it

`PilotSchema` gains an `entity` field, and the prompt asks for it (with an explicit instruction not to invent
names). `checkProvenance` then compares that entity against the run's **session log** — case titles, steps,
and observed element names. A `pass` naming an entity that does not appear there is **downgraded to
`needs-work`**, with the reason recorded rather than silently swallowed.

The asymmetry is intentional. A verdict is never upgraded by this check, only downgraded. It cannot make a
result better than the model said; it can only refuse to believe the model on a claim the run does not
support.

### 2. Only self-created data is disposable

`guardDeletion` refuses a deletion that targets pre-existing data or the resource under the current URL. Only
items the run itself created may be deleted. `isDeletionIntent` is the shared classifier, so "delete",
"clear", "remove" are recognised in one place rather than at each call site.

In the setup planner, `enforceDataProtection` sits alongside `enforceSafeStrategies` and forces **any**
deletion-intent precondition to the `manual` fallback — documented for a human to satisfy, and `test.skip`ped
in generated code. At setup time nothing is self-created, so there is no case where such a deletion is safe.

### Why these live as pure functions

`checkProvenance`, `guardDeletion` and `isDeletionIntent` are side-effect-free and take their inputs
explicitly. That is what makes each one testable in isolation — and each test was verified to **go red when
its guardrail is removed**, which is the only evidence that a guardrail is actually load-bearing rather than
decorative.

## Consequences

- **Some true passes are downgraded.** A model that names an entity using different words than the session log
  gets a `needs-work` it did not deserve. Accepted deliberately: an unnecessary review is cheap, a believed
  false pass corrupts the score and the dataset it feeds.
- **The Pilot prompt now has a required field to fill honestly.** Asking for `entity` is also a mild
  hallucination check by itself — a model with nothing to name should name nothing.
- **`--setup` cannot fully automate a class of preconditions**, by design. A journey needing a clean slate
  gets a documented manual step instead of a fabricated deletion.
- **These are not flags.** ADR-0017 makes new capabilities opt-in; these are the explicit exception, because a
  safety rule with an off switch is a safety rule with an off switch.
- **The provenance check is a heuristic, and should be read as one.** It is substring/name matching over a
  session log, not a proof of causation. It catches the invented-entity failure; it does not verify that the
  entity was created *correctly*.

## Rejected alternatives

- **Trust the Pilot and catch false passes downstream in scoring.** The score is computed *from* the verdict;
  a false pass corrupts the very signal that would have detected it, and it lands in the dataset used for
  regression experiments.
- **Prompt the model harder not to hallucinate.** A prompt is a request. A provenance check is a check.
- **Ask for confirmation before a destructive setup step.** Cairn runs unattended (CI, MCP, batch). An
  interactive prompt is not available where the risk is highest.
- **A `--allow-destructive` escape hatch.** The one legitimate use — deleting what the run itself created —
  is already permitted by the rule. A flag would exist only to enable the illegitimate case.
- **Put the guards inside the Pilot and the setup planner directly.** They would then be untestable without
  an LLM, and the deletion-intent classifier would exist in two drifting copies.
