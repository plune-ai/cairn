# Cairn

> **Cairn — an AI that walks your system and leaves a trail of tests: UI, API, unit, docs.**

[![CI](https://github.com/plune-ai/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/plune-ai/cairn/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@plune-ai/cairn)](https://www.npmjs.com/package/@plune-ai/cairn)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

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
npm install -g @plune-ai/cairn     # CLI
# or as a library:
npm install @plune-ai/cairn
```

Requires Node.js 20+. Copy `.env.example` → `.env` and fill in your keys.

## Quickstart

```bash
# 1. Capture a session (opens a browser to log in)
npm run session:save -- --url https://app.example.com/ --name myapp

# 2. Design test cases (no code) — review the .md files it writes
cairn design --url https://app.example.com/page --session myapp --checklist plan.md

# 3. (optional) Promote a manual case you decided is automatable: MTC → ATC
cairn promote --run runs/<id> --cases MTC-LOGIN-001

# 4. Automate the approved (ATC) cases → @playwright/test code, and run them
cairn automate --run runs/<id> --validate --session myapp

# …or do everything at once:
cairn explore --url https://app.example.com/page --session myapp --checklist plan.md
```

New here? Read the **[Getting started guide](docs/getting-started.md)** — it walks the whole cycle with explanations.

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
| `LLM_PROFILE` | `anthropic` \| `openrouter` \| `mixed` |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | provider keys (per profile) |
| `QA_TESTCASE_LANG` | test-case language (default `English`; e.g. `Ukrainian`, `uk`) |
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse — **cloud or self-hosted** (optional; see [below](#optional-langfuse)) |
| `BROWSER_BACKEND` | `lib` (in-process Playwright) \| `cli` |
| `BROWSER_CHANNEL` | `chrome` to use real Chrome (helps with OAuth) |
| `MAX_REPAIR` | repair attempts (default 2) |

- **Env var prefix:** every variable above is read as-is **or** with a `CAIRN_` prefix (e.g. `CAIRN_LLM_PROFILE`, `CAIRN_MAX_REPAIR`). Legacy `LEX_`/`LEXBOT_` prefixes still work but print a one-time deprecation warning — prefer `CAIRN_`.
- **Domain knowledge:** put `*.md` files in `./knowledge/` with a `url:` front-matter to inject credentials/validation rules into design.
- **Prompt overrides:** drop `./prompts/<name>.md` to override any built-in prompt without rebuilding.

## Optional: Langfuse

Langfuse is **entirely optional** — leave the `LANGFUSE_*` variables unset and the bot runs fully offline.
Everything core still works: `observe` / `design` / `automate` / `explore`, locator grounding, the LLM judge,
deterministic scorers, self-repair, and results-level learning (best cases are read from local
`runs/<id>/report.json`). Prompts fall back to the built-in defaults — override any of them with `./prompts/<name>.md`.

Set the three `LANGFUSE_*` variables to **additionally** get: traces in the Langfuse UI, scores/datasets
recorded centrally, and versioned prompts (with production labels & A/B prompt experiments via `cairn experiment`).

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
- **[Architecture Decision Records](docs/adr/)** — why it's built this way (0001–0010, incl. the interactive TUI, the `@playwright/test` output format, and the Lex-Bot → Cairn rename).

## License

GPL-3.0. Methodology prompts ported from `AZANIR/qa-skills` (see `docs/adr/0008`).
