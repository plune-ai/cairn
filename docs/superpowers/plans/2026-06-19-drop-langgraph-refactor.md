# Drop LangGraph + Ink optional + docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Behavior-preserving refactor — remove `@langchain/langgraph` (rewrite the explore graph as a plain async pipeline reusing `runRepairLoop`), rebind Langfuse telemetry at the LLM layer, make Ink/React optional, update docs.

**Architecture:** The `StateGraph` becomes `runExploreGraph(deps, init)` running the same stages as plain awaits; the generate⇄validate⇄repair portion delegates to the existing `runRepairLoop` (removing the inline keep-best duplicate). Telemetry, which `graph.invoke` used to propagate, is rebound via a lazy Langfuse root span (`@langfuse/tracing` `startActiveObservation`) wrapping each run + the `callbackHandler` threaded onto each LLM call by `RoleRouter`.

**Tech Stack:** TypeScript strict/ESM, vitest, `@langchain/core|anthropic|openai` (kept), `@langfuse/*` v5 (OTel), Ink/React (→ optional).

## Global Constraints

- Behavior-preserving: identical generated tests, `runs/<id>/…` artifacts, CLI surface, config.
- Keep `@langchain/core|anthropic|openai`; remove ONLY `@langchain/langgraph`.
- ZERO change to domain modules (observe/analyze/design/codegen/probe/validate/eval) EXCEPT the single telemetry-binding change at the LLM layer (routing/structured).
- `runExploreGraph` returns an `ExploreOutcome` with the SAME fields the two callers read:
  `study, analysis, verified, transitions, testCases, suite, validation, bestSuite, bestValidation, stoppedEarly`.
- Preserve every guard/side-effect: observe consent-wall + `describeObserveError`; identifyElements L1-05 `expiredSessionMessage`; verifyLocators degrade (`count:-1, verified:false`); exploreStates reset-to-state-0 + `.slice(0,4)`; `#38` `onStudy`/`onTestCases` best-effort; codeless short-circuit; `#40/#73` keep-best/no-progress via `runRepairLoop` (NOT reimplemented).
- Telemetry AC: ONE trace named "exploration"/"design" with per-LLM-step spans; `telemetry.callbackHandler.last_trace_id` resolves so `client.score.create` attaches. **Verified by a LOCAL smoke run** (creds are in `.env`; not CI).
- Per-task gate: `npm run typecheck && npm run lint && npm test && npm run build` (+ `npm run smoke:pack` at the end).
- Spec: `docs/superpowers/specs/2026-06-19-drop-langgraph-refactor-design.md`. Reference skeleton: the user's task message.

**Plan notes (recon-driven):**
- The graph test (`tests/unit/explore-graph.test.ts`) currently asserts `out.bestGreen` (line 121). `runRepairLoop` exposes `bestValidation`, NOT `bestGreen` — so `ExploreOutcome` has NO `bestGreen`; that assertion becomes `out.bestValidation?.greenRatio`.
- `@langfuse/tracing` is an OPTIONAL peer (lazy-imported like the rest of telemetry) — the root-span helper must no-op when telemetry is disabled.
- The v5 root-span API is `startActiveObservation(name, async (span) => { span.updateTrace({ name, metadata }); ... })` (confirmed via Langfuse v4/v5 JS docs). With an active span, a nested CallbackHandler's generations attach to it → one trace.

---

### Task 1: Rewrite `graph.ts` as a plain async pipeline (reuse `runRepairLoop`) + update call sites + tests

**Files:**
- Modify: `src/agent/graph.ts` (replace the `StateGraph` with `runExploreGraph`)
- Modify: `src/agent/index.ts` (two call sites: `runExploration` ~162-213, `runDesign` ~528; re-exports ~35)
- Modify: `tests/unit/explore-graph.test.ts`, `tests/unit/graph.test.ts` (build/invoke → call the new function)

**Interfaces:**
- Produces:
  - `interface ExploreOutcome { study: PageStudy; analysis: PageAnalysis; verified: VerifiedElement[]; transitions: Transition[]; testCases: TestCase[]; suite?: GeneratedSuite; validation?: ValidationReport; bestSuite?: GeneratedSuite; bestValidation?: ValidationReport; stoppedEarly: boolean }`
  - `runExploreGraph(deps: ExploreDeps, init: { url: string; runId: string }): Promise<ExploreOutcome>`
  - `ExploreDeps` unchanged.
- Consumes: `runRepairLoop` from `./repair-loop.js` (its `{ bestSuite, bestValidation, stoppedEarly }`).

- [ ] **Step 1: Rewrite `src/agent/graph.ts`** following the user's reference skeleton. Concretely: drop the `@langchain/langgraph` import + `ExploreState` Annotation + the `StateGraph(...).addNode(...).compile()`. Keep the body of every node as sequential code inside `runExploreGraph`, in this order, preserving each guard verbatim from the current nodes: observe (try/`capture` → `describeObserveError` throw; `findConsentDismiss` → `act` → re-`capture`; best-effort `onStudy`), identifyElements (`analyzePage`; `expectAuthenticated && looksLikeLoginPage` → throw `expiredSessionMessage`), verifyLocators (try `gateway.verify` else degrade to `count:-1, verified:false`), exploreStates (only if `analysis.viewSwitchers.length>0`; `.slice(0,4)`; reset-to-state-0 via `gateway.observe({url})`; merge fresh verified `count>=1`), probeInteractions (`probeTransitions(gateway, verified.filter(v=>v.verified))`), designTestCases (`designTestCases(...)`; best-effort `onTestCases(testCases, verified, study.url)`), then: if `deps.codeless` → `return { study, analysis, verified, transitions, testCases, stoppedEarly: false }`. Else generate⇄validate⇄repair via:

```ts
  const genAndWrite = async (repairHint?: string): Promise<GeneratedSuite> => {
    const suite = await generateSuite(
      { study, pageSemantics: analysis.pageSemantics, testCases, repairHint,
        elements: verified.filter((v) => v.count >= 1), transitions },
      { invoke: deps.codegenInvoke, prompts: deps.prompts },
    );
    await deps.runWriter.writeSuite(suite);
    return suite;
  };
  const { bestSuite, bestValidation, stoppedEarly } = await runRepairLoop({
    generate: async (hint) => {
      const suite = await genAndWrite(hint);
      deps.onProgress?.(`generateCode — ${suite.files.length} spec files written`);
      return suite;
    },
    validate: async () => {
      deps.onProgress?.("validate — running the generated tests (playwright)…");
      const v = await deps.validate(deps.runWriter.dir);
      deps.onProgress?.(`validate — ${Math.round(v.greenRatio * 100)}% green out of ${v.results.length} tests`);
      return v;
    },
    maxRepair: deps.maxRepair,
    onProgress: deps.onProgress,
  });
  return { study, analysis, verified, transitions, testCases, suite: bestSuite, validation: bestValidation, bestSuite, bestValidation, stoppedEarly };
```

  Keep `ExploreDeps` exactly as-is. Export `runExploreGraph`, `ExploreOutcome`, `ExploreDeps`. Remove `buildExploreGraph` + `ExploreState`.

- [ ] **Step 2: Update `src/agent/index.ts`.** In `runExploration`: build the deps object (the same fields currently passed to `buildExploreGraph`) as `const deps: ExploreDeps = {...}`, then replace `const graph = buildExploreGraph({...}); const out = await graph.invoke({ url, runId }, { callbacks, runName, metadata });` with `const out = await runExploreGraph(deps, { url: input.url, runId });` (telemetry comes in Task 2). Do the SAME at the `runDesign` call site (the second `graph.invoke`, ~line 528) — build `deps`, call `runExploreGraph(deps, { url, runId })`. Update the re-exports (line ~35): `export { runExploreGraph } from "./graph.js"; export type { ExploreDeps, ExploreOutcome } from "./graph.js";` (drop `buildExploreGraph, ExploreState`). Everything the callers read off `out` (`out.study`, `out.bestSuite ?? out.suite`, `out.bestValidation ?? out.validation`, `out.stoppedEarly`, `out.testCases`, `out.analysis`, `out.verified`) is unchanged.

- [ ] **Step 3: Update the graph tests.** In `tests/unit/explore-graph.test.ts` and `tests/unit/graph.test.ts`: replace `import { buildExploreGraph } from ...` with `import { runExploreGraph } from ...`; replace every `const graph = buildExploreGraph(makeDeps({...})); const out = await graph.invoke({ url, runId })` with `const out = await runExploreGraph(makeDeps({...}), { url, runId })`. **Critical fix:** the `out.bestGreen` assertion (explore-graph.test.ts:121) becomes `expect(out.bestValidation?.greenRatio).toBe(0.5)`. Keep all other assertions (`out.stoppedEarly`, `out.bestValidation`, the error-degradation regex, `onStudy`/`onTestCases` durability, codeless) unchanged.

- [ ] **Step 4: Run the gate.** `npm run typecheck && npm run lint && npm test && npm run build` — all green (graph tests pass against the new function; the validateCalls counts 2 and 3 still hold because `runRepairLoop` calls validate initial+per-attempt).

- [ ] **Step 5: Commit.**
```bash
git add src/agent/graph.ts src/agent/index.ts tests/unit/explore-graph.test.ts tests/unit/graph.test.ts
git commit -m "refactor(agent): replace LangGraph StateGraph with a plain async pipeline reusing runRepairLoop"
```

---

### Task 2: Rebind Langfuse telemetry at the LLM layer (the critical task)

**Files:**
- Modify: `src/telemetry/index.ts` (add a lazy root-span helper)
- Modify: `src/llm/routing.ts` (thread `callbackHandler` into each invoker)
- Modify: `src/llm/structured.ts` (`meteredInvoker` forwards a config to `.invoke`)
- Modify: `src/agent/index.ts` (wrap both `runExploreGraph` calls in the root span; build the router with the handler)

**Interfaces:**
- Produces: `Telemetry.runInTrace<T>(name: string, metadata: Record<string, unknown>, fn: () => Promise<T>): Promise<T>`; `RoleRouter` constructor accepts an optional `callbacks?: unknown[]`.

- [ ] **Step 1: Add the lazy root-span helper to `src/telemetry/index.ts`.** Add `runInTrace` to the `Telemetry` interface and both implementations. `noopTelemetry`: `runInTrace: (_n, _m, fn) => fn()`. In `initTelemetry` (enabled path), lazy-import `@langfuse/tracing` and implement:
```ts
  const lfTracing = await import("@langfuse/tracing");
  const runInTrace = <T>(name: string, metadata: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
    lfTracing.startActiveObservation(name, async (span) => {
      span.updateTrace({ name, metadata });
      return fn();
    });
  return { enabled: true, callbackHandler, client, runInTrace, shutdown };
```
  Add `@langfuse/tracing` to the lazy-import try block alongside the others. Update `noopTelemetry()` to include `runInTrace`.

- [ ] **Step 2: `meteredInvoker` forwards a config.** In `src/llm/structured.ts`, give `meteredInvoker` an optional `config?: Record<string, unknown>` param and pass it to invoke: `const res = (await structured.invoke(messages, config)) as { raw: unknown; parsed: T };`. (`.invoke(messages, config)` is LangChain's standard 2nd arg — a `RunnableConfig` carrying `callbacks`.) Signature of the returned `StructuredInvoke` is UNCHANGED.

- [ ] **Step 3: `RoleRouter` threads the callbacks.** In `src/llm/routing.ts`, add a constructor param `private readonly callbacks?: unknown[]` (after `onCharge`). In `invoke(role, tier)`, pass `this.callbacks ? { callbacks: this.callbacks } : undefined` as the new `config` arg to `meteredInvoker(model, ..., method, config)`. (Adjust `meteredInvoker`'s arg order accordingly — `config` last.)

- [ ] **Step 4: Wire the call sites.** In `src/agent/index.ts`, where the `RoleRouter` is constructed, pass `telemetry.callbackHandler ? [telemetry.callbackHandler] : undefined` as the new `callbacks` arg. Wrap each `runExploreGraph` call:
```ts
  const out = await telemetry.runInTrace(
    "exploration",
    { runId, backend: cfg.browser.backend, profile: cfg.llmProfile },
    () => runExploreGraph(deps, { url: input.url, runId }),
  );
```
  and the `runDesign` site with name `"design"` (+ `mode: "design"` in metadata). `telemetry.callbackHandler?.last_trace_id` (the existing score-attach code) now resolves to this root trace.

- [ ] **Step 5: Unit-test the binding.** Add `tests/unit/routing.test.ts` assertion (or extend it): a `RoleRouter` built with a sentinel `callbacks` array passes it through — use a fake `makeModelFn` returning a model whose `withStructuredOutput().invoke(messages, config)` records `config`, and assert `config.callbacks` is the sentinel. (Proves the binding is present; the live trace is Step 6.)

- [ ] **Step 6: LOCAL smoke (telemetry AC).** Run a real `cairn explore --url <fixture-or-target>` and `cairn design ...` against the local Langfuse (creds in `.env`). Confirm in the Langfuse UI: ONE trace named "exploration" (and "design") per run with nested per-LLM-step generations, and that scores attached (so `last_trace_id` resolved). Record the result in the task report. If a trace is split or `last_trace_id` is null, the rebind is wrong — fix before proceeding.

- [ ] **Step 7: Gate + commit.** `npm run typecheck && npm run lint && npm test && npm run build`.
```bash
git add src/telemetry/index.ts src/llm/routing.ts src/llm/structured.ts src/agent/index.ts tests/unit/routing.test.ts
git commit -m "refactor(telemetry): rebind Langfuse at the LLM layer (root span + handler) after dropping graph.invoke"
```

---

### Task 3: Remove `@langchain/langgraph` + delete the closed S5 spike

**Files:** `package.json`, delete `scripts/spike-s5-langfuse.ts`

- [ ] **Step 1:** `git rm scripts/spike-s5-langfuse.ts`. Remove the `"spike:s5-langfuse": "tsx scripts/spike-s5-langfuse.ts"` line from `package.json` scripts. Remove `"@langchain/langgraph": "^1.3.6"` from `dependencies`. Also update the `description` + `keywords` ("langgraph") in `package.json` to drop LangGraph (it's now a plain pipeline).
- [ ] **Step 2: Grep guard.** Confirm NO match anywhere: `grep -rn "@langchain/langgraph\|StateGraph\|Annotation.Root" src/ tests/ scripts/` → empty.
- [ ] **Step 3:** `npm install` (refresh the lockfile), then the gate `npm run typecheck && npm run lint && npm test && npm run build`.
- [ ] **Step 4: Commit.**
```bash
git add package.json package-lock.json
git commit -m "chore(deps): remove @langchain/langgraph + delete the closed S5 spike"
```

---

### Task 4: Make Ink/React optional + graceful TUI fallback

**Files:** `package.json`, `src/tui/index.ts`

- [ ] **Step 1:** In `package.json`, move `ink`, `ink-select-input`, `ink-spinner`, `ink-text-input`, `react` from `dependencies` to a new `optionalDependencies` block. Leave `@types/react` + `ink-testing-library` in `devDependencies`.
- [ ] **Step 2:** Wrap the dynamic imports in `src/tui/index.ts` `mountTui()`:
```ts
export async function mountTui(): Promise<void> {
  let React: typeof import("react")["default"];
  let render: typeof import("ink")["render"];
  let App: typeof import("./App.js")["App"];
  try {
    React = (await import("react")).default;
    ({ render } = await import("ink"));
    ({ App } = await import("./App.js"));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      process.stderr.write(
        "[cairn] The interactive TUI needs optional deps that are not installed.\n" +
          "  Install:  npm i ink react ink-select-input ink-spinner ink-text-input\n" +
          "  Or use explicit commands (no TUI needed):  cairn explore <url> · cairn design <url>\n",
      );
      return;
    }
    throw e;
  }
  const { waitUntilExit } = render(React.createElement(App), { exitOnCtrlC: true });
  await waitUntilExit();
}
```
- [ ] **Step 3: Acceptance.** `npm i --omit=optional && npm run build`, then confirm `node dist/cli/index.js explore <url>` prints progress with NO `react`/`ink` in `node_modules` (a library/explicit path), and bare `cairn` in a TTY prints the install hint instead of crashing. Then `npm i` (restore optional) → TUI mounts as before. (The `ink-testing-library` TUI tests still pass because the optional deps are present in dev.)
- [ ] **Step 4: Gate + commit.** `npm run typecheck && npm run lint && npm test && npm run build`.
```bash
git add package.json src/tui/index.ts
git commit -m "feat(tui): make ink/react optional dependencies with a graceful fallback"
```

---

### Task 5: Docs / ADR-0012 / CHANGELOG / version 0.4.0

**Files:** `README.md`, `docs/` (architecture + ADR), `CHANGELOG.md`, `package.json`, `CLAUDE.md`

- [ ] **Step 1: Grep + update prose.** `grep -rin "langgraph\|StateGraph\|state machine\|state graph" README.md docs/ CHANGELOG.md CONTRIBUTING.md .env.example CLAUDE.md` and update every architecture description: the explore flow is now a plain async pipeline (observe → identify → verify → exploreStates → probe → design → [codeless? stop] → generate ⇄ validate/repair) over the same seams (`BrowserGateway`, `StructuredInvoke`), Langfuse tracing bound at the LLM layer. Reflect ink/react as optional (with the install hint). Keep ADR cross-references consistent.
- [ ] **Step 2: ADR-0012.** Add `docs/adr/0012-drop-langgraph.md` (verify it's the next free number): context (minimize deps; LangGraph was mostly DSL sugar — trivial reducers, durability already hand-rolled via `onStudy`/`onTestCases`), decision (remove `@langchain/langgraph`, keep the langchain-core LLM layer, reuse `runRepairLoop`), consequences (lose the built-in checkpointer/streaming — already replaced by `onStudy`/`onTestCases` + `onProgress`; telemetry now bound at the LLM layer via a root span), note domain nodes untouched thanks to the seams. Optionally a short note: agent-browser evaluated/deferred, addable later behind `BROWSER_BACKEND` as an optional peer on upstream `vercel-labs/agent-browser`.
- [ ] **Step 3: CHANGELOG + version.** Add a CHANGELOG entry (drop-LangGraph + ink-optional) in the existing style; bump `package.json` `version` 0.3.4 → 0.4.0.
- [ ] **Step 4: Final verification.** `npm run typecheck && npm run lint && npm test && npm run build` + `npm run smoke:pack` (if present).
- [ ] **Step 5: Commit.**
```bash
git add README.md docs/ CHANGELOG.md package.json CLAUDE.md
git commit -m "docs: reflect the plain async pipeline + optional TUI; ADR-0012; v0.4.0"
```

---

## Final verification (after all tasks)

- [ ] Full gate + `npm run smoke:pack`.
- [ ] Grep guard: `grep -rn "@langchain/langgraph\|StateGraph\|Annotation.Root" .` (excluding node_modules/dist) → empty.
- [ ] No domain-module change beyond the telemetry binding: `git diff main...HEAD --stat` touches only agent/graph.ts, agent/index.ts, llm/routing.ts, llm/structured.ts, telemetry/index.ts, tui/index.ts, package.json, tests, docs.
- [ ] Telemetry local smoke confirmed (Task 2 Step 6).

## Self-Review (run by the author)

**1. Spec coverage:** AC1 (no langgraph) → Task 3. AC2 (runExploreGraph same fields + call sites + tests) → Task 1. AC3 (telemetry one-trace + last_trace_id) → Task 2 (Steps 1-6, local smoke). AC4 (ink optional + fallback) → Task 4. AC5 (docs/ADR/CHANGELOG/0.4.0) → Task 5. AC6 (no regression) → per-task gates + final grep/diff guard. ✓

**2. Placeholder scan:** the graph.ts rewrite references the user's reference skeleton + the listed verbatim guards (the full node bodies live in the current graph.ts the implementer is editing) + shows the runRepairLoop wiring and ExploreOutcome return in full; telemetry/ink steps show complete code. runDesign is the explicit mirror of the shown runExploration rewrite. No TBD/TODO. ✓

**3. Type consistency:** `runExploreGraph(deps, init): Promise<ExploreOutcome>` and the `ExploreOutcome` fields (no `bestGreen`) are consistent across Task 1 (definition + test fix), Task 2 (call-site wrap returns the same `out`). `Telemetry.runInTrace` signature matches its use at the call sites. `RoleRouter` callbacks param ↔ `meteredInvoker` config ↔ `.invoke(messages, config)`. ✓
