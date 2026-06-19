---
title: "Drop LangGraph + make Ink/React optional + update docs"
issue: "behavior-preserving refactor (Stage 2 of the quality-floor→refactor workflow)"
date: 2026-06-19
status: approved-by-user-task (requirements are the user's detailed task + reference skeleton) — pending plan
branch: feat/refactor-drop-langgraph (off main 4a77456 — has #57 + #58 merged)
related:
  - "User's task message (the authoritative spec) + the reference skeleton for graph.ts"
  - "#40 (5feca34) / #73 — runRepairLoop keep-best + repair-from-errors (reused, not reimplemented)"
  - "ADR-0003 BrowserGateway · ADR-0006 Langfuse OTel"
---

# Drop LangGraph + Ink optional + docs — design

## 1. Problem & goal

Three behavior-preserving changes (no change to generated tests, run artifacts, CLI surface, or config):
1. **Remove `@langchain/langgraph`** — rewrite `buildExploreGraph` (a `StateGraph`) as a plain async
   pipeline running the same stages in the same order, reusing `runRepairLoop` for generate⇄validate⇄repair.
2. **Make Ink/React optional** — the TUI is already lazy-imported; move its deps to `optionalDependencies`
   and degrade gracefully when absent.
3. **Update docs/ADR/CHANGELOG** to the new architecture.

Keep `@langchain/core` + `@langchain/anthropic` + `@langchain/openai` (the LLM layer / provider flexibility).
Only the LangGraph **orchestration** is removed.

## 2. Current state (grounded, 2026-06-19)

- **`src/agent/graph.ts`** is a `StateGraph` (`@langchain/langgraph`) with nodes observe → identifyElements
  → verifyLocators → exploreStates → probeInteractions → designTestCases → generateCode → validate ⇄ repair.
  It has its OWN inline repair loop (the `validate` node + `repair` node + `routeAfterValidate` +
  keep-best/no-progress logic inline, lines 252-307) — i.e. it **duplicates** `runRepairLoop`'s
  keep-best/no-progress. `@langchain/langgraph` is imported ONLY here (+ `scripts/spike-s5-langfuse.ts`).
- **Two call sites** in `src/agent/index.ts`: `runExploration` (`buildExploreGraph` @162, `graph.invoke` @206)
  and `runDesign` (`graph.invoke` @528). Both pass `{ callbacks: [telemetry.callbackHandler], runName, metadata }`.
- **Telemetry:** `graph.invoke` propagates `telemetry.callbackHandler` (Langfuse `CallbackHandler`) to every
  nested LLM call; `telemetry.callbackHandler.last_trace_id` (@278) is read AFTER the run to attach scores.
- **`src/tui/index.ts`** `mountTui()` already does dynamic `import("react")`/`import("ink")`/`import("./App.js")`.
- **`package.json`** has `ink`, `ink-select-input`, `ink-spinner`, `ink-text-input`, `react` in
  `dependencies`; `@types/react` + `ink-testing-library` in `devDependencies`.

## 3. Design decisions

- **Rewrite, don't re-implement keep-best:** the new `runExploreGraph(deps, init)` runs the stages as plain
  awaits and calls `runRepairLoop` for the generate⇄validate⇄repair portion — removing the inline duplicate.
  This is the user's reference skeleton.
- **Output shape stays identical:** return an object with the SAME fields the two callers read —
  `study, analysis, verified, transitions, testCases, suite, validation, bestSuite, bestValidation, stoppedEarly`.
  Replace the LangGraph `Annotation`-based `ExploreState` with a plain `ExploreOutcome` interface. `ExploreDeps`
  is unchanged.
- **Telemetry rebind at the LLM layer (the critical risk):** thread `telemetry.callbackHandler` + `runName`
  ("exploration"/"design") + `metadata` ({ runId, backend, profile, mode }) into `RoleRouter`/the model
  factory, and bind them onto each built model via LangChain `.withConfig({ callbacks, runName, metadata, tags })`.
  Keep the `StructuredInvoke` signature unchanged. **Acceptance:** with Langfuse creds present, each run still
  produces ONE trace named "exploration"/"design" with per-LLM-step spans, and `last_trace_id` still resolves
  so scores attach.
- **spike-s5-langfuse.ts:** DELETE it (+ its `spike:s5-langfuse` npm script) — S5 is a closed Sprint-0 spike,
  and the "no langgraph import anywhere" gate requires it gone. (Default; user-confirmed direction.)
- **Ink optional:** move the 5 deps to `optionalDependencies`; wrap `mountTui()`'s dynamic imports in
  try/catch → on `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND` print a friendly install hint and exit cleanly.
  Verify the headless default already prints `onProgress` to stderr with NO react/ink loaded.
- **Version:** 0.3.4 → **0.4.0** (a dependency moving to optional is a consumer-visible packaging change).

## 4. Components / files

| # | Change | File |
|---|--------|------|
| 1 | Rewrite `buildExploreGraph` (StateGraph) → `runExploreGraph(deps, init): Promise<ExploreOutcome>`; `ExploreState` Annotation → plain `ExploreOutcome` interface; reuse `runRepairLoop` | `src/agent/graph.ts` |
| 2 | Update the two call sites (`runExploration`, `runDesign`) + re-exports/types | `src/agent/index.ts` |
| 3 | Telemetry rebind: thread callbackHandler/runName/metadata, bind via `.withConfig` | `src/llm/routing.ts` (+ `src/llm/factory.ts` if needed) |
| 4 | Remove `@langchain/langgraph`; delete the S5 spike + its npm script | `package.json`, `scripts/spike-s5-langfuse.ts` |
| 5 | Ink/React → `optionalDependencies` + graceful `mountTui()` fallback | `package.json`, `src/tui/index.ts` |
| 6 | Docs/ADR-0012/CHANGELOG; version 0.4.0 | `README.md`, `docs/`, `CHANGELOG.md`, `package.json` |

## 5. Behavior-preserving invariants (MUST NOT break)

- Same stage order + every guard/side-effect: observe (consent-wall dismissal + `describeObserveError`),
  identifyElements (`expectAuthenticated && looksLikeLoginPage` → `expiredSessionMessage`, L1-05),
  verifyLocators (degrade to `count:-1, verified:false` on failure), exploreStates (reset-to-state-0, caps),
  probeInteractions, designTestCases, codeless short-circuit, generate⇄validate⇄repair via `runRepairLoop`.
- `#38` durability: best-effort `onStudy(study)` after observe; best-effort `onTestCases(...)` after design.
- `#40/#73` repair invariants come from `runRepairLoop` (keep-best + no-progress early-stop + `failedTestsHint`) —
  NOT reimplemented.
- Hard failures (observe/navigation, expired session) throw exactly as `graph.invoke` rejected → the callers'
  `try/catch → finalizeFailure` still applies.
- Telemetry: ONE trace per run named "exploration"/"design", per-step spans, `last_trace_id` resolves.
- Unchanged: generated tests, `runs/<id>/…` artifacts, CLI surface, config.

## 6. Testing

- Update the graph tests under `tests/` (they build/invoke the graph with fake deps) to the new
  `runExploreGraph` function; keep them green.
- Grep guard: no `@langchain/langgraph` / `StateGraph` / `Annotation.Root` import remains anywhere
  (incl. scripts/).
- Ink-optional acceptance: `npm i --omit=optional && npm run build && cairn explore <url>` works and prints
  progress with NO react/ink in `node_modules`; bare `cairn` in a TTY without optional deps prints the install
  hint instead of crashing; with optional deps the TUI mounts as before.
- Full gate: `npm run typecheck && npm run lint && npm test && npm run build` (+ `npm run smoke:pack`).
- If creds allow: one real `cairn explore` + `cairn design` smoke; confirm artifacts + the Langfuse trace
  unchanged.

## 7. Commits (3, per the user's task)

1. graph rewrite + telemetry rebind + tests.
2. ink optional + graceful fallback.
3. docs/ADR-0012/CHANGELOG + version bump.

## 8. Out of scope

- Adopting `vercel-labs/agent-browser` as a 3rd `BrowserBackend` (a short ADR note records it as
  evaluated-and-deferred, addable later behind `BROWSER_BACKEND` as an optional peer).
- Any change to domain modules (observe/analyze/design/codegen/probe/validate/eval) beyond the single
  telemetry-binding change at the LLM layer.

## 9. Acceptance criteria

- AC1 — no `@langchain/langgraph`/`StateGraph` import anywhere (grep clean); `@langchain/langgraph` removed
  from `package.json`; the S5 spike + its npm script deleted.
- AC2 — `runExploreGraph` returns the same fields the two callers read; both call sites updated; graph tests green.
- AC3 — telemetry: one trace named "exploration"/"design" with per-step spans; `last_trace_id` resolves and
  scores attach (verified with creds, or the binding asserted in a test).
- AC4 — ink/react in `optionalDependencies`; headless `cairn explore/design` works with `--omit=optional`;
  bare `cairn` without optional deps prints the install hint and exits cleanly; TUI mounts when deps present.
- AC5 — docs/README reflect the plain async pipeline + optional TUI; ADR-0012 added; CHANGELOG entry; version 0.4.0.
- AC6 — no regression: full gate green; generated tests / artifacts / CLI / config unchanged.
