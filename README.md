<p align="center">
  <img src="docs/assets/hero.png" alt="Cairn — an AI that walks your system and leaves a trail of tests. Autonomous QA agent for UI, API, unit & docs testing. Node.js · TypeScript · Playwright." width="100%" />
</p>

# Cairn

> **Cairn — an AI that walks your system and leaves a trail of tests: UI, API, unit, docs.**

[![CI](https://github.com/plune-ai/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/plune-ai/cairn/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@plune-ai/cairn)](https://www.npmjs.com/package/@plune-ai/cairn)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<!-- Inline player badge (optional): `asciinema upload docs/demo/cairn.cast`, then replace the line below
     with [![Cairn demo](https://asciinema.org/a/<id>.svg)](https://asciinema.org/a/<id>) — see docs/demo/. -->
▶ **Demo:** [`docs/demo/cairn.cast`](docs/demo/cairn.cast) — play with `asciinema play docs/demo/cairn.cast`

> Autonomous QA agent (Node.js / TypeScript) that logs into a web app with a saved session, explores
> pages (ARIA snapshot + screenshot), designs methodology-based UI test cases (ISO/IEC/IEEE 29119-4),
> generates runnable `@playwright/test` code, self-validates and self-repairs, and **self-improves**
> via Langfuse. A portable utility (CLI + library) for embedding into other TypeScript projects.

**Cairn is the generation layer** — it produces tests across surfaces (UI today; API / unit / docs planned),
each arriving by demand, one at a time. A separate **Plune** layer owns record / management / eval.

> **Renamed from Lex-Bot → Cairn.** The old `lex-bot` command and the `@plune-ai/lex-bot` package still
> work — the CLI prints a one-line deprecation notice — but switch to `cairn` / `@plune-ai/cairn`; the old
> names will be removed in 1–2 releases. Legacy `LEX_`/`LEXBOT_` env vars still work too; prefer `CAIRN_`.

## What it does

Point it at a URL (behind login, with a saved Playwright `storageState`) and it will:

1. **Observe** — navigate, wait for SPA hydration, capture an ARIA snapshot + screenshot, extract interactive elements.
2. **Ground** — verify every locator (`getByRole().count()`), explore tabs/views (multi-state), probe safe state transitions — so it tests what is *actually* there, not hallucinations.
3. **Design** — write methodology-based test cases (29119-4: EP / BVA / decision-table / state-transition / error-guessing), steered by an optional checklist and domain knowledge files.
4. **Generate & validate** — emit POM-style `@playwright/test` specs (role-based locators, `test.step`), run them, classify pass/fail/flaky, and **self-repair** failures (with keep-best: a repair never makes the suite worse).
5. **Judge & learn** — deterministic scorers + an LLM judge + a holistic **Pilot** verdict + semantic checklist coverage, all traced to Langfuse; accumulate the best cases across runs.

## Two decoupled modes

- **`design`** — explore + write test cases as Markdown files (`ATC-*` automatable / `MTC-*` manual) with recorded selectors. **No code.** Review them as a human, automate later.
- **`automate`** — generate `@playwright/test` code from approved `ATC-*` cases (skips `MTC-*` manual ones).
- **`explore`** — the full pipeline at once (cases → code → validation → repair → Pilot verdict).

## How it works — the full cycle

New to this? The bot writes two kinds of test case:
- **ATC** (*Automatable Test Case*) — the bot is confident it can drive reliably (read-only checks, verified locators) → it generates Playwright code for these.
- **MTC** (*Manual Test Case*) — needs a human (full form submits, security/XSS, visual/UX, irreversible actions) → left for you to run by hand.

The typical flow:

1. **Capture a session** (once) — log in so the bot can reach pages behind auth.
2. **Design** — the bot studies the page and writes test cases (`ATC-*` / `MTC-*` `.md` files with recorded selectors). No code yet.
3. **Review** — you read the cases (in the TUI: *Browse past runs* → open a run → *Cases*).
4. **Promote** *(optional)* — reviewed an `MTC` and decided it's actually automatable? `cairn promote …` (or `a` in the TUI) converts it to an `ATC` in place. It's then picked up by automate.
5. **Automate** — generate `@playwright/test` code from the `ATC` cases.
6. **Validate** — run the generated tests, classify pass/fail/flaky, and self-repair failures.

`explore` runs steps 2–6 in one go; `design` + `automate` split them so you can review (and promote) in between. Full walkthrough: **[docs/getting-started.md](docs/getting-started.md)**.

## Install

```bash
npm install -g @plune-ai/cairn      # global CLI → run `cairn …`
# …or local / library install:
npm install @plune-ai/cairn         # → run via `npx cairn …`

# one-time: download the Chromium build Cairn drives (NOT shipped inside the npm package)
cairn install-browsers              # uses Cairn's OWN Playwright → always the right Chromium revision
# …or skip the download entirely and drive your installed Google Chrome:  pass --channel chrome
```

Requires Node.js 20+. Copy `.env.example` → `.env` and fill in your keys.

> **Two ways to invoke.** A **global** install (`-g`) puts `cairn` on your PATH, so `cairn design …` works
> anywhere. A **local** install does *not* — run it as **`npx cairn design …`** from the folder where you
> installed it. The examples below use the bare `cairn`; prefix them with `npx` if you installed locally.
>
> **Browsers are a separate download.** `npm install` pulls the Playwright *library* but not its *browser
> binaries*. Run **`cairn install-browsers`** once — it uses Cairn's own Playwright, so the Chromium
> revision always matches what Cairn launches. Prefer your existing Chrome? Skip the download and pass
> **`--channel chrome`** (this is also how Cairn coexists with a project that already ships its *own*
> Playwright). Otherwise `explore` / `automate --validate` stop early with a clear *"Playwright browsers
> are not installed"* message that prints both fixes — run **`cairn doctor`** any time to see the state.

## Quickstart

> Installed locally (without `-g`)? Prefix every `cairn …` below with `npx` (e.g. `npx cairn design …`).

```bash
# 0. One-time: download the browser Cairn drives (skip if you already ran it during install,
#    or skip entirely and add --channel chrome to drive your installed Google Chrome)
cairn install-browsers

# 1. Capture a session (opens a browser to log in)
cairn session capture --url https://app.example.com/login --name myapp

# 2. Design test cases (no code) — review the .md files it writes
cairn design --url https://app.example.com/page --session myapp --checklist plan.md

# 3. (optional) Promote a manual case you decided is automatable: MTC → ATC
cairn promote --run runs/<id> --cases MTC-LOGIN-001

# 4. Automate the approved (ATC) cases → @playwright/test code, and run them
cairn automate --run runs/<id> --validate --session myapp

# …or do everything at once:
cairn explore --url https://app.example.com/page --session myapp --checklist plan.md
```

The `--checklist` file steers **what** the bot tests (and is scored as coverage). Copy
[`examples/plan.md`](examples/plan.md) — a ready-to-run checklist for `https://plune.ai/cairn` — as a starting point.

New here? Read the **[Getting started guide](docs/getting-started.md)** — it walks the whole cycle with explanations.

## Authenticated targets

Cairn explores your app **as a logged-in user**. You capture the login **once** into a Playwright
`storageState` (cookies + localStorage); every later run reuses it — no credentials in code, no
re-login per run.

```bash
# 1. Capture once — a real browser opens; log in by hand, then press Enter.
cairn session capture --url https://your-app.example.com/login --name myapp

# 2. Point Cairn at any page behind that login, reusing the session.
cairn explore --url https://your-app.example.com/dashboard --session myapp
```

- **Pointing Cairn at your OWN gated app?** That's the intended flow — capture against your login page, then `explore` / `design` any authenticated page with `--session <name>`.
- **OAuth / Google login** (blocks automated browsers): add `--channel chrome` to drive your real Google Chrome. `--channel` works on `session capture`, `observe`, `design`, `explore`, and `automate --validate` — and needs **no bundled-Chromium download**, so it's also the simplest way to run inside a project that already has its own Playwright. (Without a channel, Cairn uses the bundled Chromium from `cairn install-browsers`.)
- **Manage sessions:** `cairn session ls` lists saved sessions; `cairn session rm <name>` deletes one. (`cairn login` is a shorthand for `cairn session capture`.)
- **Already have a `storageState.json`?** Skip capture and pass it directly: `--session-file ./path/to/state.json`.
- **Expired session?** If the first page Cairn sees looks like a login screen, it stops with a clear *re-capture* message instead of exploring the sign-in page.
- **Secrets hygiene:** sessions live in `.auth/` (matching `*.storageState.json`), which is **gitignored** — never committed. Treat the files like passwords.

> Working inside the repo? `npm run session:save -- --url <u> --name <s>` still works — it's a thin wrapper over the same capture logic that ships as `cairn session capture`.

## Interactive TUI

Run `cairn` with **no arguments** in a terminal to open the interactive TUI (built with Ink):

```bash
cairn          # launches the terminal UI
```

Pick a command (explore / design / automate), fill parameters (URL, session, checklist, style) via a
guided form, watch a **live dashboard** of the graph nodes as the run progresses, read the result summary
(scores, green %, Pilot verdict, test cases), and **browse past runs** in `./runs` — opening any run to
read its test cases, report and logs.

The commands below stay available for scripting/CI; in a non-interactive (piped/CI) shell, `cairn` with
no arguments prints help instead of starting the UI.

## Commands

| Command | Purpose |
|---|---|
| `cairn session capture --url <loginUrl> --name <s>` | Capture a login session once → `.auth/` (`cairn login` is a shorthand; `session ls` / `session rm`) |
| `cairn observe --url <u> [--session <s>]` | ARIA snapshot + interactive elements + screenshot |
| `cairn design --url <u> --session <s> [--checklist <f>] [--style <s>]` | Test cases only (ATC/MTC `.md` + selectors), no code |
| `cairn automate --run <dir> [--validate --session <s>]` | `@playwright/test` from `ATC-*` cases |
| `cairn promote --run <dir> --cases <ids> [--session <s>]` | Promote manual MTC case(s) to ATC (.md only; then `automate`) |
| `cairn explore --url <u> --session <s> [--checklist <f>]` | Full pipeline (cases → code → validate → repair → Pilot) |
| `cairn experiment --dataset <d> --candidate name=file` | Compare prompt versions on a dataset |

> `lex-bot <command>` still runs every command above (deprecated alias — prints a notice, then runs `cairn`).

## Configuration (env)

| Var | Purpose |
|---|---|
| `LLM_PROFILE` | `anthropic` \| `openrouter` \| `mixed` (per-tier default models) |
| `LLM_ROUTING` | per-role preset: `fast` (Groq worker) \| `volume` (OpenRouter worker) — see [Role routing](#role-routing) |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` | provider keys (per profile / routing) |
| `QA_TESTCASE_LANG` | test-case language (default `English`; e.g. `Ukrainian`, `uk`) |
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse — **cloud or self-hosted** (optional; see [below](#optional-langfuse)) |
| `BROWSER_BACKEND` | `lib` (in-process Playwright) \| `cli` |
| `BROWSER_CHANNEL` | `chrome`/`msedge` → drive a system browser (helps with OAuth; **no bundled-Chromium download**, and coexists with a host project's own Playwright). Per-command flag: `--channel`. |
| `MAX_REPAIR` | repair attempts (default 2) |

- **Env var prefix:** every variable above is read as-is **or** with a `CAIRN_` prefix (e.g. `CAIRN_LLM_PROFILE`, `CAIRN_MAX_REPAIR`). Legacy `LEX_`/`LEXBOT_` prefixes still work but print a one-time deprecation warning — prefer `CAIRN_`.
- <a id="role-routing"></a>**Role routing (`LLM_ROUTING`, optional):** layer a cheap **worker** over any profile while keeping the strong **reasoner**. One flag picks where the mechanical steps (identify-elements, generate-code/repair) run:
  - `fast` → worker on **Groq** `llama-3.3-70b-versatile` — lowest latency/cost, OpenAI-compatible tool-calling.
  - `volume` → worker on **OpenRouter** `deepseek/deepseek-chat` — model breadth.
  - default (unset) → the profile's own per-tier models.

  In **every** preset the reasoner (design test cases + Pilot verdict) stays on **Anthropic** `claude-opus-4-8` for judgment quality, and the cheap `judge` scorer keeps the profile tier (routing never touches it). Override any role with `CAIRN_ROLE_WORKER` / `CAIRN_ROLE_REASONER=provider:model`; pass `--routing <preset>` on `explore`/`design`/`automate` to set it per run. Per-run **per-role cost** (tokens + $) is printed in the run summary.
- **Domain knowledge:** put `*.md` files in `./knowledge/` with a `url:` front-matter to inject credentials/validation rules into design.
- **Prompt overrides:** drop `./prompts/<name>.md` to override any built-in prompt without rebuilding.

## Cost benchmark

What does a run cost on each [routing preset](#role-routing)? The table below is generated by
`npm run bench`: it runs `cairn explore` against a fixed target once per preset and reads the per-run
cost ledger (tokens + $) already written into each run's `report.json` (L1-01) — it re-prices nothing.
Treat the numbers as an **approximate, single-run snapshot** (LLM token counts vary run-to-run).

<!-- BENCHMARK:START -->
<!-- Generated by `npm run bench` — do not edit between the BENCHMARK markers by hand. -->

_Snapshot: 2026-06-13 · commit `a2906cf` · profile `anthropic` · MAX_REPAIR=0 · target: `https://demoqa.com/text-box` (no session) · approximate, single-run._

| Preset | Worker | Reasoner | Tokens/run | $/run | Wall-clock/run | $/hour† |
|---|---|---|---|---|---|---|
| `default` | claude-haiku-4-5+claude-sonnet-4-6 | claude-opus-4-8 | 27,191 | $0.2854 | 390.6s | $2.63 |
| `volume` | deepseek/deepseek-chat | claude-opus-4-8 | 13,923 | $0.1209 | 58.2s | $7.48 |
| `fast` | llama-3.3-70b-versatile | claude-opus-4-8 | n/a — run failed: 400 Failed to call a function. Please adjust your prompt. See 'fail… | — | — | — |

† **$/hour is an extrapolation**, not a steady-state rate: `$/run × (3600 / seconds-per-run)` — the cost if runs fired back-to-back for an hour. Real throughput varies with target complexity, retries, and provider latency.

Reproduce: `npm run bench -- --url https://demoqa.com/text-box --session <name>`

> Token counts vary run-to-run (LLM nondeterminism). OpenRouter/Groq prices are approximate and movable ([ADR-0002](docs/adr/0002-llm-anthropic-tiering.md)); Anthropic prices follow the published rates. `$/run` is `—` when a model has no configured price (tokens are still counted).
<!-- BENCHMARK:END -->

Regenerate it yourself — you need the provider keys for the presets you want measured and, ideally, a
[captured session](#authenticated-targets) so the target is a real page rather than `example.com`:

```bash
npm run bench -- --url https://your-app.example.com/dashboard --session myapp --write
```

For reproducibility the benchmark **pins `LLM_PROFILE=anthropic` and `MAX_REPAIR=0`** (both shown in the
snapshot line) instead of inheriting your `.env` — so `default` always means the same baseline and the
[reasoner stays on Opus in every preset](#role-routing); only the worker changes. Override with
`--profile <p>` / `--max-repair <n>`. A preset whose provider key is unset is **skipped** and shown as
`n/a`, so a partial run (e.g. only `ANTHROPIC_API_KEY` available) still produces a useful table.

## Optional: Langfuse

Langfuse is **entirely optional** — leave the `LANGFUSE_*` variables unset and the bot runs fully offline.
Everything core still works: `observe` / `design` / `automate` / `explore`, locator grounding, the LLM judge,
deterministic scorers, self-repair, and results-level learning (best cases are read from local
`runs/<id>/report.json`). Prompts fall back to the built-in defaults — override any of them with `./prompts/<name>.md`.

Set the three `LANGFUSE_*` variables to **additionally** get: traces in the Langfuse UI, scores/datasets
recorded centrally, and versioned prompts (with production labels & A/B prompt experiments via `cairn experiment`).

Tracing ships as an **optional add-on** (0.3.3): the `@langfuse/*` / `@opentelemetry/*` packages are no
longer part of the default install — that keeps the footprint small and `npm audit` clean. Install them
once to enable it:

```bash
npm install @langfuse/client @langfuse/langchain @langfuse/otel @langfuse/tracing @opentelemetry/api @opentelemetry/sdk-node
```

If the `LANGFUSE_*` variables are set but the packages aren't installed, Cairn prints a one-line hint and
keeps running **without** tracing — it never crashes a run over telemetry.

**Cloud or self-hosted — same setup.** Langfuse Cloud and a self-hosted instance are configured identically:
you only pass the host URL and the API keys, nothing else changes.

```bash
# Pick ONE base URL:
LANGFUSE_BASE_URL=https://cloud.langfuse.com       # Langfuse Cloud (EU)
# LANGFUSE_BASE_URL=https://us.cloud.langfuse.com  # Langfuse Cloud (US)
# LANGFUSE_BASE_URL=https://langfuse.your-host.tld # self-hosted
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

> Enablement is all-or-nothing: Langfuse turns on only when **all three** variables are set; otherwise
> telemetry is a no-op and the bot behaves exactly as offline.

## Library API

```ts
import { runDesign, runAutomate, runExploration, loadConfig } from "@plune-ai/cairn";

const config = loadConfig(process.env);
const result = await runDesign({ url, config, sessionName: "myapp", checklistText });
// result.testCases, result.testCaseFiles, result.scores
```

## Development

```bash
npm run build        # tsc
npm test             # vitest (unit + integration; LLM/browser are mocked in unit)
npm run test:coverage
npm run lint
```

## Documentation

- **[Getting started](docs/getting-started.md)** — step-by-step onboarding (session → design → review → promote → automate → validate), written for people new to the tool.
- **[Architecture overview](docs/architecture/overview.md)** — how the agent works inside (the LangGraph state machine, locator grounding, self-improvement).
- **[Architecture Decision Records](docs/adr/)** — why it's built this way (0001–0012, incl. the interactive TUI, the `@playwright/test` output format, the Lex-Bot → Cairn rename, and the Apache-2.0 relicense).

## License

Apache-2.0 (relicensed from GPL-3.0 in 0.3.0 — see [`docs/adr/0012`](docs/adr/0012-relicense-to-apache-2.0.md)). Methodology prompts ported from `AZANIR/qa-skills` (see `docs/adr/0008`).
