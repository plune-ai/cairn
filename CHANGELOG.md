# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Journey state & data setup — `--setup` (#60).** Multi-page journeys (#59) often need a
  starting state beyond auth (a logged-in user *with* specific data). With `--setup`, Cairn turns each
  journey's prose preconditions into **structured** ones (worker tier, `CAIRN_ROLE_WORKER`) and assigns
  a satisfaction **strategy** in priority order: reuse the captured **session** → a Playwright
  **fixture** (`beforeEach`) → an **API seed** when a concrete endpoint is named → a documented
  **manual** fallback. It emits a runnable `@playwright/test` spec per journey under `runs/<id>/journeys/`,
  with the setup established **before** the steps; steps stay read-only (`toBeVisible`) and refs are
  resolved per page. Safety: an `api-seed` without a concrete endpoint is **downgraded to manual** —
  Cairn never fabricates (possibly destructive) seeding. Opt-in; absent `--setup`, nothing changes.
  The setup plans are recorded in `report.json` (`flow.setup`).

- **Multi-page / flow exploration — `--flow` / `--max-pages N` (#59).** Opt-in, Cairn now follows
  in-app navigation from the start page to build a **page/flow graph** (nodes = studied pages, edges =
  observed transitions), reusing the captured `--session` storageState across pages, and designs
  **multi-page USER JOURNEY cases** (ordered steps that cross page boundaries) in **addition** to the
  per-page cases. The crawl is pure browser mechanics (no LLM), bounded by `--max-pages` (default 3),
  stays in-origin, dedupes revisits, and **never follows destructive links** (log out / delete) — so
  the session and read-only safety hold across the whole walk. Journey steps are grounded **per page**
  (a step only references elements that exist on its own page), and only journeys spanning ≥2 distinct
  pages are kept. The graph + journeys are persisted in `report.json` (`flow`) and rendered in
  `report.md`. Without `--flow`, single-page behavior is byte-for-byte unchanged. The design
  methodology / assertion-safety rules are untouched.

- **First-class prompt overrides + house-style packs (#80).** A committed `prompts/` scaffold now
  ships in the repo: a `prompts/README.md` documenting the override precedence (Langfuse →
  `prompts/<name>.md` → built-in constant) and `prompts/qa-testcase-from-ui.md` — the built-in design
  prompt **verbatim** — so you can see exactly what is overridable (a drift guard keeps it in sync).
  `--style <value>` is promoted to a dual resolver: a **style pack** (`prompts/styles/<value>.md` or an
  explicit `.md` path) is loaded into the prompt's `{{style}}` slot, otherwise it falls back to the
  existing inline hint (`happy` / `negative` / `coverage`). Three built-in packs ship —
  `concise`, `gherkin`, `detailed-manual`. Style affects **only** naming / format / language / tone;
  it never changes technique coverage or assertion safety (the methodology stays fixed). Back-compat:
  the short `--style happy|negative|coverage|all` behavior is unchanged.

- **`--critique` flag on `cairn design` and `cairn explore` (#82)** — an opt-in design-time
  self-critique pass that runs once AFTER the first design set and BEFORE finalization. On the cheap
  **worker** role (`CAIRN_ROLE_WORKER`) it (a) prunes trivial / contradictory / unverifiable cases and
  (b) tops up techniques under-represented across the 6 × ISO/IEC/IEEE 29119-4 set — feeding quality
  signal back into generation instead of only scoring it post-hoc. The prune/top-up delta (cases
  pruned, techniques added, technique-coverage before→after) is recorded in `report.json` under
  `critique`, next to the existing `technique_coverage` / `case_redundancy` metrics. Bounded to a
  **single** worker-tier LLM call; conservative default (**off** unless `--critique` is passed). The
  methodology and assertion-safety rules are unchanged — the pass only prunes and fills gaps, and
  top-up refs are grounded against real elements like the main design step. Behavior is identical to
  before when the flag is absent.

- **`--fresh` flag on `cairn design` and `cairn explore`** (and a matching TUI toggle) — ignore
  prior-run experience for a URL. By default a 2nd+ run on the same URL reuses its *previously stable*
  cases as design-prompt context and generates only the **delta** (new cases); `--fresh` skips that
  disk read entirely (`collectPriorRuns`) and generates a **full set** every time, for clean A/B
  comparisons. The gate is shared by both flows via `experienceForUrl()` in `src/eval/collect.ts`.
  Behavior is unchanged when the flag is absent — no generated artifact differs. (See ADR-0006.)
- **Inline metric legend.** `report.md`'s Metrics table now carries a `meaning` column and a ↑/↓
  direction per metric (plus a one-line key explaining the glyphs and the `judge` tag); the console
  `=== Metrics ===` output appends the same ↑/↓ glyph so `case_redundancy` / `flaky_ratio` (lower is
  better) can't be misread. A new README **Metrics** section documents every metric. All three render
  from one source of truth — `METRIC_LEGEND` in `src/eval/legend.ts` — so they can't drift. No metric
  value or name changed.

### Changed

- **Slimmed the README into a ~30-second shop window (#81).** The README is now ≤ ~150 lines in a
  what/why → install → quickstart → command table → doc-links order; the reference material moved into
  dedicated, linked pages under `docs/`: `sessions.md` (authenticated targets), `configuration.md`
  (env + role routing), `prompts-and-styles.md` (NEW — methodology vs style, override precedence,
  `--style` packs), `tui.md`, `metrics.md`, `cost.md`, `langfuse.md`. The `BENCHMARK` markers moved
  with the cost section, so `npm run bench` now rewrites `docs/cost.md` (was `README.md`), and the
  `KEEP IN SYNC` note for the metric legend now points at `docs/metrics.md`. No code behavior changed.

## [0.4.0] - 2026-06-19

### Changed

- **Drop `@langchain/langgraph` — plain async pipeline (ADR-0013).** The LangGraph
  `StateGraph` / `Annotation.Root` orchestrator is replaced by `runExploreGraph(deps, init):
  Promise<ExploreOutcome>` — a plain async function with sequential `await` calls for each
  stage. The stage seams (`BrowserGateway`, `StructuredInvoke`) and all domain node bodies are
  untouched. The generate⇄validate⇄repair portion now delegates to the existing `runRepairLoop`
  helper (removing the inline keep-best duplicate). `@langchain/core` (provider-agnostic LLM
  factory) is retained; only the graph orchestration layer is removed.
- **Telemetry rebound at the LLM layer.** Each run is wrapped in a lazy Langfuse root span
  (`startActiveObservation` from `@langfuse/tracing`); `RoleRouter` threads the
  `@langfuse/langchain` `CallbackHandler` into every LLM call config — preserving the full
  nested trace structure (one root span, one nested generation per stage LLM call) without
  LangGraph as the propagation vehicle. `last_trace_id` is returned in `ExploreOutcome`.
- **Ink / React are now optional.** The TUI packages (`ink`, `react`, `ink-select-input`,
  `ink-text-input`, `ink-spinner`) moved from `dependencies` to `optionalDependencies`. A
  default `npm install @plune-ai/cairn` no longer pulls them — install them manually to enable
  the interactive TUI (`npm i ink react ink-select-input ink-spinner ink-text-input`). If the
  packages are absent, `cairn` with no arguments falls back gracefully to printing help.

### Removed

- **`@langchain/langgraph`** from `dependencies` and the codebase (no import anywhere — grep clean).
- **`scripts/spike-s5-langfuse.ts`** and its npm script (`spike:s5-langfuse`) — the S5 spike is
  closed and its langgraph import is no longer valid.

> **Backward compatibility:** the public API (`runExploration`, `runDesign`, `runAutomate`,
> `loadConfig`), all `explore` / `design` / `automate` / `observe` CLI commands, existing
> configs, sessions, and run artifacts are unchanged. Telemetry and the TUI are opt-in — install
> their optional packages to use them. Tests: 416 green (vitest), coverage gate passes.

[0.4.0]: https://github.com/plune-ai/cairn/compare/v0.3.4...v0.4.0

## [0.3.4] - 2026-06-18

### Fixed

- **Interactive TUI: promote more than one manual case per review session.** In the run-detail review
  (`cairn` TUI → open a run → Cases tab), pressing `a` to promote a manual case (MTC → ATC) worked only
  ONCE per mount — every later `a` was swallowed until you exited the review and re-entered. Two causes:
  a one-shot `promoted` flag set on the first promote and never reset, and the `useInput` handler closing
  over a stale case snapshot between rapid keypresses. The handler now reads the current case + selection
  through refs (never a mount snapshot), the in-flight guard resets on completion, the case list reloads
  and re-sorts after each promote, and the selection is clamped to stay in range. You can now promote
  MTC #1, navigate to MTC #2, press `a`, and it promotes too — no exit/re-enter. Promoting an
  already-ATC case is a safe no-op.

[0.3.4]: https://github.com/plune-ai/cairn/compare/v0.3.3...v0.3.4

## [0.3.3] - 2026-06-18

### Fixed

- **Works inside projects that already have Playwright.** Cairn no longer pulls a second, *alpha*
  `playwright-core`: the experimental `cli` backend's `@playwright/cli` is now an optional peer, so a
  default install resolves a **single stable `playwright-core`** — the same build Cairn launches at
  runtime and the same one its installer targets. Previously the alpha needed a Chromium revision a
  normal `playwright install` never provided, so Cairn reported *"Playwright browsers are not
  installed"* even after following the suggested command.
- **The browser preflight no longer blocks the channel / reuse paths.** `explore` and
  `automate --validate` now pass the configured browser channel to the preflight, so `--channel chrome`
  / `BROWSER_CHANNEL=chrome` drives your installed Google Chrome with **zero download**, and an
  already-installed compatible Chromium is reused instead of demanding a re-install. The generated
  `@playwright/test` config carries the channel end-to-end.
- **Accurate browser diagnostics.** The "browsers not installed" message now prints Cairn's own
  Playwright version, the exact Chromium it expects, and the two real fixes — never the generic
  `npx playwright install` hint, which resolved to the *wrong* Playwright and so never helped.

### Added

- `cairn install-browsers` — downloads the Chromium build Cairn drives using **Cairn's own** Playwright,
  so the revision always matches what Cairn launches (regardless of any other Playwright in the project).
- `cairn doctor` — diagnoses the browser setup (Playwright version, expected Chromium, how to fix).
- `--channel <chrome|msedge>` on `explore`, `design`, `automate`, and `observe` (maps to
  `BROWSER_CHANNEL`) — drive a system browser with no bundled-Chromium download.

### Changed

- **Langfuse / OpenTelemetry are now optional.** `@langfuse/*` and `@opentelemetry/*` moved out of the
  default dependencies (to optional peers); telemetry lazy-loads them only when Langfuse is configured
  and silently no-ops when they're absent. This removes the only `npm audit` moderate
  (`@opentelemetry/core <2.8.0`) from a default install and roughly **two-thirds** of the footprint
  (clean-dir prod packages: **265 → 87**). To enable tracing, install the packages listed in the README.

> **Backward compatibility:** the default `lib` browser backend, the public API, and existing configs
> are unchanged. Tracing and the experimental `cli` backend are opt-in — install their (now optional)
> packages to use them.

[0.3.3]: https://github.com/plune-ai/cairn/compare/v0.3.2...v0.3.3

## [0.3.0] - 2026-06-14

### Added

- Per-role model routing (`worker`/`reasoner`) with `LLM_ROUTING` presets `volume` (OpenRouter) and `fast` (Groq), plus `CAIRN_ROLE_*` overrides; per-run, per-role cost & token reporting in `report.md` / `report.json` / the CLI. (#6, #7)
- Groq provider. (#7)
- Reproducible cost benchmark via `npm run bench`. (#8)
- First-class session management — `cairn session capture | ls | rm` (and the `cairn login` alias) — with missing/expired-session UX. (#27)

### Changed

- License: relicensed from GPL-3.0-only to Apache-2.0 (permissive; patent grant). See ADR-0012.
- `cairn explore` hardening: graceful browser/observe error handling, repair-loop no-progress convergence, `CallBudget` usage surfaced in the output, and a clearer first-run summary. (#26)
- Pilot verdict now runs on the strong `reasoner` role (was the cheap `judge` tier). (#6)
- The decoupled `design → automate` flow now runs the same validate⇄repair⇄keep-best loop as `explore`, and `explore` now also emits ATC/MTC case files to `testcases/`. (#39, #40)

> **Backward compatibility:** `LLM_PROFILE` and existing configs are unchanged — per-role routing, cost reporting, and the new session commands are additive and opt-in.

[0.3.0]: https://github.com/plune-ai/cairn/compare/v0.2.1...v0.3.0
