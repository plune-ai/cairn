---
title: "#57 Flaky-hardening — robust selectors + proper waits"
issue: "plune-ai/cairn#57 (L2-03, epic L2 #47)"
date: 2026-06-19
status: approved (design) — pending implementation plan
related:
  - "#40 (5feca34) — runRepairLoop: validate⇄repair⇄keep-best"
  - "#73 (0ae46a1) — repair-from-errors: failure messages into the repair hint"
  - "ADR-0005 — test output format (@playwright/test)"
  - "Refactor (drop LangGraph) — sequenced AFTER this; unifies explore onto runRepairLoop"
---

# #57 Flaky-hardening — design

## 1. Problem & goal

Generated `@playwright/test` specs flake — the #1 E2E pain. Reduce flakiness by (a) ranking
selector strategies (**role+name > test-id > css > text**), (b) preferring proper waits over
sleeps, and (c) steering away from locators the reward signal shows as flaky.

**Behavior contract:** generated tests change *for the better*; CLI surface, run artifacts
(`runs/<id>/…`), and config are unchanged. Everything stays behind the existing seams
(`BrowserGateway`, `StructuredInvoke`, `onProgress`). **No new stage in `agent/graph.ts`.**

## 2. Current state (grounded in code, 2026-06-19)

- **`src/codegen/index.ts`** is fully prompt-driven: elements are *described* to the LLM as
  `ref · role "name"` (+ `.first()` for repeats); the spec code itself is written by the model via
  the `qa-playwright-ts-writer` prompt. **No deterministic post-processing of generated code.**
- **`src/validate/index.ts`** already detects flakiness: runs the suite N times (`reruns`, default 2),
  classifies each test `passed | failed | flaky` (Spike S4). Signal is **per-test** (by title),
  carrying the first failure message. `greenRatio` excludes flaky.
- **`src/eval/scorers.ts`** already computes `flaky_ratio`, `grounding`, and `locator_quality`
  (binary user-facing vs fragile — **counts `getByTestId` as fragile**, which conflicts with the DoD
  ranking that puts test-id above css).
- **Repair loop invariants we MUST NOT break (#40 + #73):**
  - `runRepairLoop` (`src/agent/repair-loop.ts`) — shared validate⇄repair⇄keep-best with no-progress
    early-stop. **Currently only `automate` uses it; `explore` has its own repair node in `graph.ts`**
    (the LangGraph→runRepairLoop unification is the *later* refactor's job).
  - `failedTestsHint(results)` builds `"- <test>: <error clipped 500>"` for every non-green test.
    `status !== "passed"` includes **flaky** → flaky tests already feed their error into the hint.
  - keep-best compares `greenRatio`; flaky ∉ green → de-flaking already raises greenRatio and is
    already rewarded.
  - Protected by `tests/unit/repair-loop.test.ts`, `runner-output.test.ts`, `validate.test.ts`.

## 3. Design decisions

- **Q1 — measurement:** a controlled **fixture page** + existing `flaky_ratio` at higher reruns as a
  deterministic CI gate (before/after). Not the live login-gated target.
- **Q2 — mechanism:** **prompt-hardening + a deterministic anti-pattern lint fed into the existing
  repair loop.** NOT a fragile post-gen AST rewrite; NOT prompt-only.
- **Q3 — wiring (this ships before the refactor):** prompt-hardening goes into `codegen` (helps BOTH
  explore and automate immediately); the reactive lint-hint is scoped to `runRepairLoop` (automate
  now; explore inherits it for free when the later refactor unifies the loop). **Zero `graph.ts`
  change here → no collision with the refactor.**

## 4. Components

| # | Change | File | Nature |
|---|--------|------|--------|
| 1 | `lintSuite(suite): LintFinding[]` — deterministic anti-pattern detector; single source of truth for "what is fragile" | `src/codegen/lint.ts` *(new)* | pure, no I/O, never throws |
| 2 | Prompt-hardening: explicit locator ranking + wait rules; per-element preferred-locator annotation | `qa-playwright-ts-writer` prompt (`prompts/local/*.md`) + element formatting in `generateSuite` | proactive, both paths |
| 3 | Reactive lint-hint: optional `lint?: (suite) => string` dep; hint = `[failedTestsHint(results), lint?.(suite)].filter(Boolean).join("\n")` | `src/agent/repair-loop.ts` + injection at the automate call-site | additive, back-compatible |
| 4 | `locator_robustness` (tiered) secondary score from lint; leave `locator_quality` untouched | `src/eval/scorers.ts` | new score, non-breaking |
| 5 | Flaky-prone fixture + a discrimination harness | `tests/fixtures/flaky-prone/` + `tests/integration/` | measurement |

> Note: the exact automate call-site that constructs the `runRepairLoop` deps (where `lint` is
> injected) is located during planning — grep the automate command wiring (likely `src/cli/` or
> `src/agent/index.ts`).

## 5. Data flow (two independent paths)

- **Proactive (always, both paths):** `generateSuite` → hardened `qa-playwright-ts-writer` prompt
  (explicit ranking + wait rules) → the LLM emits robust locators on the FIRST generation. Primary
  lever; no loop change.
- **Reactive (non-green only, automate now):** inside `runRepairLoop`, lint the suite that just
  failed (the `suite` in scope when the hint is built), append its findings *after*
  `failedTestsHint(results)`. With no `lint` dep the loop is byte-identical to today.

## 6. Lint rules + ranking model

DoD ranking **role+name > test-id > css > text** is encoded by `lintSuite`:

| Severity | Pattern | Guidance emitted |
|----------|---------|------------------|
| high (fragile-locator) | `.locator(`, `page.$(`, css / `:nth` / `>>` / XPath | "replace with getByRole/name" |
| mid (prefer-role) | `getByTestId(` | "test-id ok as fallback, but role+name is better" — reconciles the scorer conflict |
| high (bad-wait) | `waitForTimeout(`, `networkidle` | "use web-first `await expect(loc).toBeVisible()`" |
| ok | `getByRole/Label/Text` + intentional `.first()`/`.nth()` | none |

`LintFinding = { file: string; kind: 'fragile-locator' | 'prefer-role' | 'bad-wait'; detail: string }`.
`locator_robustness` weighting: role+name = 1.0 · label/text/placeholder = 0.8 · testid = 0.5 ·
css/xpath/locator = 0.0.

## 7. Measurement & DoD proof (deterministic, no live LLM)

1. **Lint unit tests** — each pattern is caught (no browser).
2. **Fixture discriminator** — a hand-written *fragile* spec (css/`nth`/`waitForTimeout`) vs a
   *hardened* spec (getByRole/web-first), both run against the fixture at `reruns: 5`; assert the
   fragile one is flaky and the hardened one is not. Proves the instrument actually catches flake.
3. **Codegen-emits-hardened** — `lintSuite(recorded generation)` → zero high-severity findings and
   `locator_robustness ≥ 0.8`. Proves the new prompt actually yields robust locators.

Together these demonstrate before (fragile) → after (hardened) flaky-rate drop without depending on
the live login-gated target.

## 8. Behavior-preserving guarantees

- `lintSuite` is pure and never throws; empty findings → hint identical to today.
- `runRepairLoop` with no `lint` dep → identical behavior (guards #40/#73 tests).
- `failedTestsHint`, keep-best, and no-progress early-stop are **not touched**.
- The prompt changes generated code for the better but keep the contract (`GeneratedSuite`,
  getByRole style); regressions are caught by keep-best (a worse generation is not accepted) and by
  the recorded-LLM integration tests.
- **Unchanged:** CLI, config, `runs/<id>/` artifacts, `graph.ts`.

## 9. Testing

- `tests/unit/codegen-lint.test.ts` *(new)* — lint rules.
- `tests/unit/repair-loop.test.ts` — extend: with a `lint` dep the hint includes findings; WITHOUT a
  `lint` dep the hint is unchanged (guards the #73 behavior).
- `tests/unit/scorers.test.ts` — `locator_robustness` tiering.
- `tests/integration/flaky-fixture.test.ts` *(new)* — fixture discrimination.
- Existing repair/runner/validate tests stay green and untouched.

## 10. Out of scope (non-goals)

- Per-locator flaky attribution (mapping a flake to a specific locator) — the reward stays test-level.
- Cross-run / per-app memory of flaky locators — overlaps MEM-02 (#64, partner).
- Wiring the reactive lint-hint into `explore`'s repair node — arrives for free with the later refactor.
- Deprecating / re-baselining the existing `locator_quality` scorer (kept as-is; YAGNI).

## 11. Acceptance criteria (maps to the board DoD)

- AC1 — generated specs prefer robust locators: a recorded generation lints with zero high-severity
  fragile-locator/bad-wait findings; `locator_robustness ≥ 0.8`.
- AC2 — proper waits: no `waitForTimeout`/`networkidle` in generated specs; web-first assertions used.
- AC3 — measured flaky-rate drops: at `reruns: 5` against the fixture, the hardened spec is stable
  (`flaky_ratio = 0`) while the fragile spec is flaky (`flaky_ratio > 0`).
- AC4 — reward signal feeds repair: with the `lint` dep, a non-green automate run's repair hint
  contains lint findings alongside the failure errors.
- AC5 — no regression: full gate green (`typecheck + lint + test + build + smoke:pack`); CLI/config/
  artifacts/`graph.ts`/`failedTestsHint` unchanged.

## 12. Sequencing note

Ships as Stage 1a of the agreed workflow (`#57 → #58 → refactor`). Keeping all changes inside domain
modules (`codegen`/`validate`/`eval`) + `repair-loop.ts` and out of `graph.ts` is the discipline that
prevents a collision with the later LangGraph-drop refactor that rewrites `graph.ts`.
