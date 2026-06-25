# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MCP server — `cairn mcp` (#49).** Cairn's core is now exposed as an
  [MCP](https://modelcontextprotocol.io) server, so other agents (Claude Code, Cursor) can call test
  generation as a tool. `cairn mcp` starts a **stdio** server with three tools — **`explore`** (cases +
  `@playwright/test` code + validate ⇄ repair), **`design`** (cases only), and **`automate`** (code
  from a previous run's ready cases) — thin adapters over the same `runExploration` / `runDesign` /
  `runAutomate` core the CLI uses (config / role routing / cost reused, no new generation logic).
  `explore`/`design` input mirrors the `explore` flags (`url` + optional
  `session`/`flow`/`setup`/`gaps`/`critique`/`fresh`/`checklist`/`style`/`routing`/`backend`/`maxPages`);
  `automate` takes `run` (the run dir) + optional `validate`/`session`. Results return as structured
  JSON (cases or spec files, validation, metrics, the Pilot verdict, cost, run dir).
  `@modelcontextprotocol/sdk` is an **optional dependency** (lazy-loaded only on the `cairn mcp` path,
  like Ink for the TUI). Connect snippet: [docs/mcp.md](docs/mcp.md).

### Changed

### Fixed

- **OpenRouter codegen/reasoning latency — `explore`/`design` no longer hang (#110).** On the
  `openrouter` profile / `volume` routing, `deepseek-chat` (codegen) ran 4.5–13 min and `deepseek-r1`
  (reasoner) overran interactive/MCP timeouts without finishing. Two fixes:
  - **Per-step timeout** (`STEP_TIMEOUT_MS`, default **240000 ms** / 4 min; `0` disables). Each
    structured LLM call is now bounded — a pathologically slow provider fails fast with an **actionable
    error** (suggesting a faster `--routing`/Anthropic, or raising `STEP_TIMEOUT_MS`) instead of hanging
    indefinitely, which the MCP server's caller cannot otherwise observe. Healthy Anthropic steps
    (~90 s) are unaffected.
  - **New `volume-fast` routing preset** (`--routing volume-fast` / `LLM_ROUTING=volume-fast`): codegen
    + analyze (worker) on Anthropic Sonnet — fast where `deepseek-chat` is not — while the cheap
    LLM-as-judge scorer stays on OpenRouter via `LLM_PROFILE`. Unlike `fast` (Groq), it avoids the
    large-codegen `json_schema` 400 (`groq-fast-json-schema-bug`), so it is the recommended escape for
    slow OpenRouter codegen.

## [0.5.0] - 2026-06-24

### Added

- **Provenance-checked Pilot verdicts + data-protection guardrails (#91).** Two cheap safety rules
  (borrowed from Explorbot) that land **before** any stateful / destructive automation. (1) The Pilot's
  holistic `pass` is now **provenance-checked**: the verdict carries the name of the entity the run
  claims to have created/edited, and a `pass` is downgraded to `needs-work` (reason recorded) when that
  entity is **absent** from the run's session log (case titles + steps + observed element names) —
  killing a class of LLM false-positives. (2) A reusable `guardDeletion` policy refuses to delete
  **pre-existing** data or the resource under the **current URL**; only self-created items are
  disposable. The setup planner gains `enforceDataProtection`, which forces any delete/clear
  precondition to the **manual** fallback (at setup time nothing is self-created yet, so such a deletion
  would hit pre-existing data). Pure helpers in `src/safety/guardrails.ts`; the Tester side stays
  read-only by existing prompt policy.

- **Coverage gap-analysis (#61).** After design, every run now emits a **coverage view** — the observed
  interactive surface (elements per page + flow transitions, #59) **minus** what any case or journey
  references (by `elementRefs` + journey steps). `report.json` gains a `coverage` block and `report.md`
  a **Coverage** section: covered vs observed-but-untested, grouped by page, each gap with a short
  "why it matters", plus any untested transitions. With **`--gaps`**, Cairn additionally suggests cases
  for the top untested elements (worker tier), grounded to the gap refs and clearly marked as
  SUGGESTIONS (a `gap-` id prefix). The coverage view is read-only and additive (it changes no generated
  test artifact); `--gaps` is opt-in and bounded (top-N gaps) to keep cost predictable.

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

### Fixed

- **Flow runs persist per-page crawl snapshots (#103).** A multi-page `--flow` run left only the start
  page's `snapshots/aria.yaml` + `screenshot.png`, even though the crawl studied every page — each
  `FlowNode.study` held a full aria/screenshot that was then discarded. Each crawled node now gets its
  own `snapshots/<index>-<slug>/aria.yaml` + `screenshot.png` (index-prefixed → collision-safe), and
  `report.json`'s `flow.pages[]` carries a per-page `snapshot` reference so the page graph is
  inspectable. The start page's root `snapshots/` files are unchanged (single-page runs unaffected).

- **Flow crawl now follows links on client-routed SPAs (#102).** `explore --flow` built a 1-node graph
  on SPA front-ends (e.g. Next.js): after a link click the router updates `location.href` asynchronously,
  but `observe` returned the cached `currentUrl` (only refreshed on an explicit navigation), so every
  crawled URL collapsed back to the start → 0 cross-page journeys → the setup planner never ran. The
  crawl now (a) waits for the URL to change after a click (`ObserveOptions.waitForUrlChange`, polled
  best-effort in the lib backend) and reads the **live** `page.url()` when not navigating explicitly,
  and (b) dedups links by `(name, href)` so a repeated link name (e.g. 3× "See the platform") isn't
  followed multiple times. Link hrefs are captured from the ARIA `/url` property. Server-side navigation
  (click → new URL + full load) is unchanged.

- **`explore` no longer crashes with EBUSY on Windows during repair (#101).** The artifact writer
  fully overwrites `tests/` on every generation (`writeSuite`), but on Windows the Playwright runner
  from the just-finished validation can still hold a handle there — so the recursive `rm` threw
  `EBUSY`/`EPERM` and the whole run rejected on the first repair attempt. Cleanup now goes through a
  resilient `rmrf` helper that retries the recursive remove with exponential backoff on transient lock
  codes (`EBUSY`/`EPERM`/`ENOTEMPTY`) and, if the lock never clears, gives up cleanly (best-effort)
  instead of sinking the run. POSIX behaviour is unchanged (the first attempt always wins) and non-lock
  errors still propagate immediately. The same guard is applied to `writeJourneySpecs`.

- **Provider-safe strict JSON schemas for all structured LLM invokes (#89).** Strict structured-output
  providers (Groq `fast`, OpenRouter `volume`, Anthropic tool-calling) require **every** property to be
  in `required`; an `.optional()` key is dropped from `required` and causes intermittent cross-provider
  schema-parse failures. The lone offending schema — `StructuredPreconditionSchema`'s
  `entity`/`endpoint`/`method` — moves from `.optional()` to `.nullable().default(null)`: kept in
  `required` (provider-safe) yet tolerant of a provider that omits the key (parses to `null`). A new
  **schema-lint** (`src/llm/schema-lint.ts`, over zod 4's native `z.toJSONSchema`) asserts
  `required == properties` across all 9 structured-invoke schemas, with a drift guard that fails the
  build if a new `invoke(...Schema)` isn't covered. Validated live on both `volume` (OpenRouter) and
  `fast` (Groq); a companion `qa-setup-planner` prompt tweak makes the weaker Groq model always emit the
  nullable keys as `null` (strict tool-call validation rejects an omitted required key).

- **Tiered transient-error recovery in BrowserGateway (#90).** A transient SPA navigation error (an
  in-app redirect aborting the in-flight `goto`, a network blip, a load-state timeout) previously killed
  the step — `observe()` did a bare `page.goto` with no handling. Navigation now runs through a
  classification ladder (`src/browser/recovery.ts`): a **transient** error gets a cheap settle + retry on
  the **same** page — grounded state (the ref→locator map) is preserved — and only a **fatal** /
  retry-exhausted error escalates to the expensive recovery (recreate the page on the same context; auth
  survives, grounding is rebuilt). Unknown errors default to `fatal`, so real bugs aren't masked by
  silent retries. lib backend (PRIMARY); the CLI backend is out of scope.

- **Robust `--run` / `--from-run` path resolution on Windows / Git-Bash (#79).** In Git Bash an
  unquoted backslash is a shell escape, so `--run runs\<id>` reached the process as the glued `runs<id>`
  (the separator eaten before Node ran) → `ENOENT` on the testcases path. A new `src/fs/run-dir.ts`
  resolves `runs/<id>`, an absolute path, a bare `<id>`, and recovers the glued case; otherwise it
  throws an actionable error listing available runs plus a bare-id / Git-Bash tip. `readInputFile` gives
  a friendly `ENOENT` (+ Git-Bash tip) for file flags (`--checklist` / `--dataset` / `--candidate`), and
  `defaultRunsBaseDir()` becomes the single source for the runs base dir (was duplicated 5×).

[0.5.0]: https://github.com/plune-ai/cairn/compare/v0.4.0...v0.5.0

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
