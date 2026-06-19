---
title: "#58 Case-quality guardrails — dedup + technique coverage"
issue: "plune-ai/cairn#58 (L2-06, epic L2 #47)"
date: 2026-06-19
status: approved (design) — pending implementation plan
branch: feat/58-case-quality (off main 0ae46a1 — independent PR, NOT stacked on #57/PR #74)
related:
  - "#57 (PR #74) — flaky-hardening; established the deterministic-detector + sibling-scorer pattern reused here"
  - "Refactor (drop LangGraph) — sequenced AFTER this; #58 adds no graph.ts stage to avoid collision"
---

# #58 Case-quality guardrails — design

## 1. Problem & goal

Generated suites can be padded with near-duplicate cases and skew to one or two techniques — "50
redundant clicks" instead of a meaningful suite. Add two deterministic guardrails: **dedup**
near-identical cases (merge the obvious, flag the borderline) and **report technique coverage** across
the ISO/IEC/IEEE 29119-4 techniques.

**Behavior contract:** generated cases get better (deduped, technique-diverse); CLI surface, run
artifacts (`runs/<id>/…`), and config are unchanged. Everything stays behind the seams
(`StructuredInvoke`, `onProgress`). **No new stage in `agent/graph.ts`; no design-retry loop.**

## 2. Current state (grounded in code, 2026-06-19)

- **`src/design/index.ts`** `designTestCases` is prompt-driven (`qa-manual-test-designer` +
  `qa-testcase-from-ui` → `DesignResultSchema` → `TestCase[]`), grounds `elementRefs` to known refs.
  It is a **single LLM call** — there is no design-side repair loop (unlike codegen's `runRepairLoop`).
  **No dedup, no coverage enforcement.**
- **`src/design/schema.ts`** `TestCase` already carries `technique` (enum of 6: `equivalence-partitioning`,
  `boundary-value`, `decision-table`, `state-transition`, `exploratory`, `error-guessing`), plus
  `type` (Positive/Negative), `kind` (static/active), `execution` (auto/manual), `priority`, `steps`,
  `elementRefs`.
- **`qa-testcase-from-ui` prompt** already says "No duplicates or trivialities" — it asks, but does not
  guarantee. (Same shape as #57, where the prompt already banned css and the real gap was waits.)
- **`src/eval/scorers.ts`** has no technique-coverage or redundancy score (it gained `locator_robustness`
  in #57). `checklist_coverage` is a different thing (checklist items, not 29119-4 techniques).

## 3. Design decisions

- **Q1 — scope:** two **deterministic** guardrails (`dedupCases` + `technique_coverage`); "meaningfulness"
  is the emergent result (no redundant filler + technique breadth), NOT a separate subjective/LLM score.
  An LLM-judge `case_meaningfulness` may be added later as a sibling if the deterministic proxies prove
  insufficient.
- **Q2 — dedup behavior:** **tiered** — deterministically MERGE only high-confidence duplicates, FLAG
  borderline ones (kept in the output, counted in the report). Merge runs **inside** `designTestCases`
  → zero `graph.ts` change.
- **Q3 — technique coverage:** **measure + nudge**, not hard-enforce. A `technique_coverage` score every
  run + a prompt nudge to diversify techniques. NO coverage-gated design-retry (that would build a second
  repair loop in the very stage the later refactor rewrites — deferred to Stage 2+).

## 4. Components

| # | Change | File | Nature |
|---|--------|------|--------|
| 1 | `dedupCases(cases): { merged: TestCase[]; flagged: DuplicateGroup[] }` + exported `caseSimilarity(a, b): "merge" \| "flag" \| "distinct"` (the tier verdict for one pair) | `src/design/dedup.ts` *(new)* | pure, deterministic, never throws |
| 2 | apply dedup at the end of `designTestCases` (return `merged`; emit a dedup `onProgress` line) | `src/design/index.ts` | output quality ↑, signature unchanged |
| 3 | `technique_coverage` + `case_redundancy` scores | `src/eval/scorers.ts` | new, siblings to `locator_robustness` |
| 4 | technique-diversity nudge (+ reinforce "no duplicates") | `qa-testcase-from-ui` prompt (`prompts/local/*.ts`) + doc | proactive |

## 5. Data flow

- **Proactive:** the prompt nudge → the LLM emits more diverse, less redundant cases on the first pass.
- **Deterministic safety net:** `dedupCases` merges residual high-confidence duplicates inside
  `designTestCases`, which returns the merged `TestCase[]` (same signature; downstream unaffected).
- **Measurement:** `technique_coverage` + `case_redundancy` scores every run, plus an `onProgress` line
  (`designTestCases — dedup: merged N, flagged M borderline`).

## 6. Dedup rules (conservative — protect technique diversity)

`DuplicateGroup = { representative: TestCase; duplicates: TestCase[]; reason: "merged" | "flagged" }`.

| Tier | Condition | Action |
|------|-----------|--------|
| **merge** (high-confidence) | same `technique` AND same `type` AND identical `elementRefs` set AND normalized-`steps` Jaccard ≥ 0.9 | keep ONE representative (by `priority` critical>high>medium>low; tie → more steps; tie → earliest), drop the rest |
| **flag** (borderline) | same `(technique, type)` AND `elementRefs` overlap > 0 but NOT identical, OR identical normalized `title` with differing `elementRefs` | keep in output; count in the report (NOT dropped) |
| keep | different `technique` OR `type`, or no `elementRefs` overlap | unchanged |

- The merge key includes **`type`** so a Positive and a Negative case are never merged.
- Normalization (in `caseSimilarity`): lowercase, trim, collapse whitespace; steps compared as a set
  (Jaccard over normalized step strings). `elementRefs` compared as sorted sets.
- Threshold is deliberately high (whole triple + Jaccard 0.9) — a `boundary-value` case and an
  `equivalence-partitioning` case on the same field must both survive.

## 7. Scorers (DRY — one definition of "near-duplicate")

- **`technique_coverage`** = distinct `technique` values present / 6. Value 0–1. (Measure; Q3.)
- **`case_redundancy`** = (cases involved in ≥1 borderline-flag pair) / total cases, on the FINAL
  (post-dedup) set. Value 0–1, lower is better. It reuses the SAME
  `caseSimilarity(a, b): "merge" | "flag" | "distinct"` helper that `dedupCases` uses, exported from
  `design/dedup.ts` (eval already imports design types → importing the helper is legal) — one source of
  truth for "near-duplicate", avoiding the lint↔scorer asymmetry #57's final review flagged. On the
  post-dedup set no pair is `"merge"` (those were already removed), so this effectively counts `"flag"`
  pairs.

## 8. Behavior-preserving guarantees

- `dedupCases` is pure and never throws; 0 or 1 case → returned as-is.
- Conservative merge (whole triple must match) → minimal coverage-loss risk; diversity protected by §6.
- `designTestCases` signature is unchanged (returns `TestCase[]`); the merge changes only the case COUNT
  (the intended improvement, analogous to #57's prompt changing generated code). Grounding/`elementRefs`
  filtering is untouched.
- **Unchanged:** CLI, config, `runs/<id>/` artifacts, `graph.ts`; no design-retry loop.

## 9. Testing (all deterministic — no browser; the LLM is mocked)

- `tests/unit/dedup.test.ts` *(new)* — high-confidence dups merged (count drops, representative kept by
  priority); borderline flagged but NOT dropped; a `boundary-value` vs `equivalence-partitioning` case on
  the same field is NOT merged (diversity protected); a Positive vs Negative pair is NOT merged.
- `tests/unit/scorers.test.ts` — `technique_coverage` (distinct/6) and `case_redundancy` (near-dup pairs/total).
- `tests/unit/design.test.ts` — with a mocked `invoke` returning duplicate cases, `designTestCases`
  returns the deduped set.
- A prompt test (extend/new) — `qa-testcase-from-ui` nudges technique diversity.

## 10. Out of scope (non-goals)

- A subjective/LLM-judge `case_meaningfulness` score (deferred; deterministic proxies first).
- Hard coverage enforcement / a coverage-gated design-retry loop (would add a second repair loop to the
  design stage the later refactor rewrites — deferred to Stage 2+).
- Surfacing flagged groups as a new artifact field (kept to a score + progress line to preserve the
  artifact format).
- Cross-run learning of redundant patterns (MEM territory).

## 11. Acceptance criteria (maps to the board DoD)

- AC1 — technique coverage reported: every run emits a `technique_coverage` score = distinct techniques / 6.
- AC2 — redundancy reported: every run emits a `case_redundancy` score + an `onProgress` dedup line.
- AC3 — high-confidence duplicates merged: `dedupCases` drops cases matching the whole merge key, keeping
  the highest-priority representative; `designTestCases` returns the merged set.
- AC4 — borderline flagged, not dropped: borderline-similar cases remain in the output and are counted.
- AC5 — diversity protected: cases differing in `technique` OR `type` OR `elementRefs` are never merged.
- AC6 — no regression: full gate green (`typecheck + lint + test + build`); CLI/config/artifacts/`graph.ts`
  and the `designTestCases` signature unchanged.

## 12. Sequencing note

Stage 1b of the workflow (`#57 → #58 → refactor`). On `feat/58-case-quality` off `main` (independent of
PR #74) — expect a small, resolvable `scorers.ts` conflict at merge (both #57 and #58 add a score before
`return scores`). Keeping all changes inside `design/` + `eval/` and out of `graph.ts` is the discipline
that prevents a collision with the later LangGraph-drop refactor.
