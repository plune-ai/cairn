# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`cairn api` — `multipart/form-data` request encoding (#150, C1-04 / API-10).** The runner
  (`runner.ts`) now encodes a case's body as real `multipart/form-data` (boundary, per-part
  `Content-Disposition`, correct `Content-Type`) when the operation declares it, instead of always
  JSON-encoding — via Node's native `FormData`/`File` (undici), which generates the wire format
  itself rather than a hand-rolled encoder. Case generation (`cases.ts`) synthesises a `format:
  binary` property (e.g. a file-upload field) as a real in-memory `Buffer` instead of the literal
  string `"string"`, so a multipart body has actual file content to send. A new fixture spec
  (`tests/fixtures/api/multipart-upload.yaml`) exercises this end to end: generate → run against a
  mocked server → correct encoding asserted. Follow-ups (out of scope here): `--negative` (API-8)
  doesn't yet propagate `bodyMediaType` to its corrupted-body case for a multipart operation, and
  array-of-files (`items: { format: binary }`) synthesises only one file, mirroring the existing
  one-element array behaviour for every schema type.

- **`cairn api` — multi-endpoint scenario chains / journeys (#146, C1-04 / API-9).** New `--scenarios`
  flag: given the ingested spec, chains related operations on the same resource (a *collection* path
  like `/pets` plus an *item* path templated one level deeper, `/pets/{id}`) into an ordered
  create→read→update→delete scenario, using whichever of those the spec actually declares (a resource
  with no downstream op — nothing to read/update/delete a created resource with — gets no scenario).
  Each step is a normal API-2 happy-path case; the runner (`scenario-runner.ts`) threads a value
  captured from an earlier step's response into a later step's matching param — preferring a declared
  OpenAPI `links` expression (`$response.body#/...`) when the spec has one, falling back to a
  same-named response-body field otherwise. A failing step aborts the rest of the scenario (its
  remaining steps are recorded, not silently dropped, with a `skipped —` reason) rather than
  cascading one real failure into several meaningless ones. Per-scenario (and per-step) pass/fail is
  reported alongside the existing per-operation results: a new stdout section, `report.json`'s
  `scenarios` field, and a `## Scenarios` section in `report.md`. Opt-in, so the existing default
  (1 case per operation) is unchanged for everyone not passing the flag. Follow-ups (out of scope
  here): scenario steps aren't folded into the spec-vs-tested coverage report or ATC `.md` docs, both
  of which are shaped around single operations today.

- **`cairn api` — stricter contract validation + negative-schema cases (#145, C1-04 / API-8).**
  Response-schema conformance now goes through `ajv` (+ `ajv-formats`) instead of the hand-rolled
  structural checker: `format`/`pattern`/`minimum`/`maximum`/`additionalProperties` are now enforced,
  not just type/required/properties/items/enum/allOf/oneOf/anyOf. Circular schemas from swagger-parser's
  dereference (e.g. `Pet.friends -> Pet`) are de-cycled before compiling so ajv doesn't recurse forever.
  New `--negative` flag: generates one additional contract-violation case per operation that has
  something to violate (a request-body property flipped to the wrong JSON type, or a required
  query/header/cookie param omitted — path params are left alone since removing one just breaks
  routing), expecting the declared 4xx (or a generic `4XX` range) rather than acceptance. Tagged
  `type: "Negative"` / technique `error-guessing`, flowing through the same run/report/coverage/ATC
  pipeline as the happy-path cases — a distinct case category, not a parallel one.

- **`cairn api` — Playwright codegen from ATC cases (#144, C1-04 / API-7).** `cairn automate --run
  <runDir>` — the same decoupled design→automate contract web runs use — now also works on an API
  run (`report.json`'s `mode: "api"`, API-4): it reads the ATC `.md` cases (API-5) and generates a
  runnable `tests/api.spec.ts` using `@playwright/test`'s `request` fixture, one `test()` per case,
  asserting the declared success status (exact/`default`/`NXX`, same vocabulary as the runner). No
  LLM call — every field a request needs (method/path/params/body/expected status) is already fully
  structured in the case, so codegen is deterministic templating (the same reasoning as API-2's case
  generation). The generated suite imports nothing from `cairn`, so it runs standalone in CI; `baseURL`
  defaults to the recorded value but is overridable per-environment via `API_BASE_URL`. `--validate`
  is a web-only concept (needs a browser/session) and is a no-op (with a progress note) on an API run.

- **`cairn api` — spec-vs-tested coverage report (#136, C1-04 / API-6, `playswag`-style).** Given the
  ingested spec (API-1) and the generated/executed cases (API-2/API-3), `cairn api` now reports which
  operations are untested and which are only **partially** exercised: an operation is `covered` only
  when every response status it declares (e.g. `200` **and** `404`) has a matching case, `partial`
  when some (but not all) are, and `uncovered` when none are. Since every API-2 case is still a single
  happy-path call, any operation declaring more than one response is `partial` by construction — a
  concrete, honest signal (endpoint coverage ≠ test-pass rate) rather than a percentage that looks
  better than it is. Shown as a summary + gaps-only listing on stdout, in `report.md` (new `## Coverage`
  section), and as `coverage` in `report.json`; works without `--base-url` too (spec-vs-generated-cases).
  Matching is by `operationId`/`METHOD path` (shared with case generation, `apiEndpointKey`), and the
  spec's own `deprecated` flag is surfaced per row rather than filtered out. Feeds BORROW-07 (#95,
  adversarial styles) and L2-05 coverage gap-analysis.

- **`cairn api` — Plune-record write + methodology rigor (#135, C1-04 / API-5).** A `--base-url` run now
  emits every generated case as an **ATC artifact** (`runs/api-<id>/testcases/<id>.md`) — the same
  `testcases/<id>.md` boundary web runs already write, so Plune ingests API cases identically. Each
  case is **methodology-tagged**: an ISO/IEC/IEEE 29119-4 `technique` (currently `equivalence-partitioning`
  — the valid class API-2's happy-path synthesis embodies) plus a per-case coverage **rationale**
  explaining what it exercises and why, both in the case's own frontmatter/fields and surfaced in
  `report.json` (`cases[]`) and the case listing on stdout. Each ATC's `status` is **provenance-checked**
  (aligned with BORROW-04, #91): it only reads "Passed" when a same-named, positively-asserted result
  exists — never inferred from the mere absence of a failure. Cases-only invocations (no `--base-url`)
  are unchanged (print-only, matching API-1..4 precedent) — no run directory exists yet to write into.

- **`cairn api` — reporting + run summary/TUI integration (#134, C1-04 / API-4).** A `--base-url` run
  now writes `report.json` + `report.md` alongside the existing `api-evidence.json`, in the same
  shape/location web runs already use — so the TUI's past-run browser (`Past runs`) lists api runs
  too, showing per-operation pass/fail and endpoint coverage instead of green%/pilot. The CLI's final
  line is now the **shared** `renderRunSummary` footer ("Operations: X/Y passed · N endpoint(s)
  covered", evidence path, artifacts dir) — the same renderer web runs use, not a parallel one.

- **`cairn api` — runner + response assertions (#133, C1-04 / API-3).** With `--base-url <url>`,
  `cairn api` now **executes** the generated happy-path cases (API-2) and, per case, asserts the HTTP
  **status** matches the declared success code and the response **body conforms** to the declared
  success schema (a minimal structural check: type/required/properties/items/enum/nullable +
  `allOf`/`oneOf`/`anyOf`). Auth/headers come from **config** (`--header "Name: Value"`, repeatable)
  layered over **api-scope knowledge** (#92 — `header.*` front-matter in `all`/`api` files, with
  `${ENV}` resolved so the secret stays in the environment, not the file); config wins. Transient
  faults (connection reset / timeout / `429` / `5xx`) **retry with backoff** before failing, reusing
  the tiered-recovery pattern from #90; DNS/refused and `4xx` fail fast. Per-case request/response
  **evidence** (sensitive headers redacted) is written to `runs/api-<id>/api-evidence.json`, and any
  failed assertion exits non-zero. Network is fully injectable (mocked in tests). **The rich report /
  Plune-record write are API-4.**

- **`cairn api` — baseline happy-path cases (#132, C1-04 / API-2).** From the ingested endpoint model,
  `cairn api` now generates **one nominal happy-path case per operation**: required params and a
  request body are synthesised straight from the (dereferenced) JSON schema — respecting
  `example` → `default` → `enum` → type, `required`, `format`, `allOf`/`oneOf`, and circular `$ref`s —
  paired with the operation's declared success response (lowest `2xx`, else `default`). Synthesis is
  **pure and deterministic** (no LLM, so the same spec yields byte-identical cases); the command prints
  the generated cases beneath the model summary. **Still no runner** — execution + assertions are
  API-3 (#138).

- **`cairn api` — OpenAPI ingest (#22, C1-04 / API-1).** The `api` modality leaves the gate one slice
  at a time. This first slice registers `cairn api --spec <path|url>` (parity with `cairn explore`) and
  ingests an **OpenAPI 3.x** spec — JSON or YAML, local file or `http(s)` URL — into an internal
  endpoint model (method, path, params, request/response schemas, `operationId`, security), then prints
  a verifiable summary (*"N endpoints across M tags"* + the endpoint list). `$ref`s (incl. circular)
  and 3.0/3.1 are handled via `@apidevtools/swagger-parser`; a malformed/unsupported spec fails with a
  clear message and a non-zero exit, never a crash. **No case generation yet** — that, the runner and
  the report are API-2 (#137); the Plune-record write + methodological rigor are API-3 (#138).

- **Per-scenario screencast recording — `--screencast` (#94, BORROW-05).** Validation can now record a
  `.webm` per scenario (Playwright's built-in video) into `runs/<id>/screencasts/`, with a
  `screencasts.json` sidecar mapping each scenario's **step chapters** (step title → timecode) — a
  review-gate affordance so a human can *watch* what the agent did before approving. Opt-in
  (`cairn explore --screencast` · `cairn automate --validate --screencast`); off by default, so existing
  runs are unchanged. The `.webm` paths + chapter counts are linked from the run summary and the TUI result
  screen. Recording is best-effort: a recorder/IO failure logs nothing fatal and never sinks the run.

- **Documentarian — cached, reusable page-understanding artifact (#93, BORROW-06).** A run now emits a
  strict-schema **interaction map** (element → locator + container + candidate actions) as a first-class
  artifact (`runs/<id>/page-understanding.json`) and caches it cross-run under `.cairn-cache/understanding`,
  keyed by `url + page fingerprint` (a hash of the ARIA snapshot). A second run on the **same** page reuses
  the cached understanding and **skips the ground (`analyzePage`) LLM call** → fewer observe/ground calls;
  a changed page misses the cache and re-grounds (deliberate invalidation). The map is assembled
  deterministically from existing observe/verify/probe outputs — no extra LLM call is introduced. `--fresh`
  bypasses the cache. Cross-run/per-app semantic memory stays out of scope (that is MEM-02, #64).

- **Scope-aware knowledge injection — `scope: web | api | all` (#92, BORROW-03).** `knowledge/*.md`
  files now declare a scope and are keyed by `url || path || endpoint`. Directory convention:
  `knowledge/` = web (keyed by `url:`), `knowledge/api/` = api (keyed by `path:`/`endpoint:`), and an
  explicit `scope:` front-matter overrides the directory default. A web run injects web+all, an api run
  injects api+all, and a shared `scope: all` file (e.g. credentials) is available to both. Plumbing
  ahead of the API surface (#22) — improves web runs today. Back-compatible: an existing base-dir
  `url:` file with no `scope:` stays web-scoped and behaves exactly as before.

- **Goal-directed exploration — `cairn explore --goal "..."` (#63, MEM-01).** Accept a natural-language
  goal (e.g. `"test the checkout flow"`) and bias the run toward it instead of a blind crawl: the goal
  threads into both observation (`identify-elements` prioritizes goal-relevant elements) and planning
  (the case designer leads with goal-relevant cases). Passed per-run through the existing input path
  (like `--checklist`, nothing hardcoded). Fully back-compatible — without `--goal` the prompts are
  byte-identical and the crawl is unchanged.

- **CI / PR bot — GitHub Action (#50).** A reusable composite action (`action/`) that runs Cairn on a
  pull request, posts (or updates) a **summary comment**, and **optionally opens a follow-up PR** with
  the generated tests. `v1` is generation-on-PR; maintenance/self-heal stays in epic #46. The action is
  a thin wrapper over the shared core via a new `cairn ci` command (same pattern as `cairn mcp`, #49):
  inputs flow in as `INPUT_*` env, provider keys are read from repo secrets (never hardcoded), and
  generated specs land in the host Playwright project through the `--into-project` writer (#51).
  Behavior: the comment is **idempotent** (matched by a hidden marker — re-runs update, never
  duplicate); a `paths` glob gates on the PR's **changed surface** (no match → a no-op comment, no run);
  the follow-up PR is **opt-in** (`open-pr`, `explore` mode only); **fork PRs** (read-only token) skip
  the write effects with a logged reason. Required secrets/permissions are documented in
  [`action/README.md`](action/README.md) for a repo admin to set — the action never configures them.

- **Plug into existing Playwright projects — `--into-project` (#51).** Cairn can now write the
  generated specs straight into a host project's Playwright setup instead of the greenfield
  `runs/<id>/tests` folder. `cairn explore … --into-project [dir]` / `cairn automate … --into-project [dir]`
  (and the `intoProject`/`projectDir` inputs on the public API + MCP `explore`/`automate` tools)
  detect the nearest `playwright.config.{ts,js,mjs,cjs}` (walking up from the cwd, or from an explicit
  `dir`), resolve its `testDir`, and emit specs there using the project's filename convention
  (`.spec.ts` vs `.test.ts`, read best-effort from `testMatch`). Placement is **collision-safe** — a
  pre-existing spec is never overwritten; Cairn disambiguates its own file (`login.cairn.spec.ts`)
  instead. Validation/repair still run against an isolated `runs/<id>/tests` sandbox (same Playwright,
  identical result — so the user's existing suite is never run or deleted); the validated best specs
  are then ejected into the project's `testDir` (single deliverable, discoverable by the project's own
  `npx playwright test`) and the sandbox is removed, while the `runs/<id>/` trail keeps
  study/report/testcases. Without the flag, behavior is unchanged (greenfield `runs/`). When the flag
  is set but no config is found, Cairn logs that and falls back to greenfield (no failure).

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
