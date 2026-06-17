# Getting started with cairn

New to cairn — or to UI test automation in general? This guide takes you from zero to a generated,
validated `@playwright/test` suite, explaining each step as you go.

## What cairn does (in one paragraph)

You point it at a web page; it logs in (with a saved session), studies the page, and writes **test cases**
in a human-readable Markdown format. Cases it's confident it can automate become **ATC** files; cases that
need a human stay as **MTC** files. From the ATC cases it generates real `@playwright/test` code, runs it,
and repairs failures. You stay in control: review the cases first, automate only what you approve.

## Two kinds of test case: ATC vs MTC

- **ATC — Automatable Test Case.** Read-only checks (visibility, enabled state, text) on elements with
  reliable, verified locators. The bot generates Playwright code for these.
- **MTC — Manual Test Case.** Things a bot shouldn't drive blindly: full form submission, security/XSS,
  visual/UX judgment, irreversible actions. Left for a human to run.

If you review an MTC and decide it really is safe to automate, **promote** it — see Step 5.

## Prerequisites

- **Node.js 20+**.
- An **LLM API key**: `ANTHROPIC_API_KEY` (default) or `OPENROUTER_API_KEY` (cheaper). This is the only
  required key — Langfuse and the rest are optional.
- For pages behind a login: a **saved session** (Step 2).

## Step 1 — Install and configure

```bash
npm install -g @plune-ai/cairn      # global → `cairn …`   (local install? use `npx cairn …`)

# one-time: download the Chromium build Cairn drives (not bundled with the npm package)
npx playwright install chromium
```

> If you skip `npx playwright install chromium`, the first command that needs a browser (`explore`,
> `automate --validate`, `observe`, or capturing a session) stops with a clear message telling you to run
> exactly that — so this is a quick fix, not a mysterious failure.

Create a `.env` (copy `.env.example`) with at least your LLM key:

```
ANTHROPIC_API_KEY=sk-ant-...
# or:  OPENROUTER_API_KEY=sk-or-...   and   LLM_PROFILE=openrouter
```

## Step 2 — Capture a session (for pages behind login)

```bash
npm run session:save -- --url https://app.example.com/ --name myapp
```

A browser opens; log in manually. Your cookies + localStorage are saved to `.auth/myapp.storageState.json`.
Skip this step for public pages.

## Step 3 — Your first run

The easiest way to start is the **interactive TUI** — run the bot with no arguments:

```bash
cairn
```

Pick **Design** (writes test cases, no code yet), fill in the URL and pick your session, and watch the live
dashboard as it works. When it finishes you'll see the cases and where they were written
(`runs/<id>/testcases/`).

Prefer the command line?

```bash
cairn design --url https://app.example.com/page --session myapp
```

## Step 4 — Review the cases

In the TUI: from the launcher choose **Browse past runs**, open your run, and look at the **Cases** tab.
Navigation: switch tabs with `1`/`2`/`3` or `←→`, scroll with `↑↓`, move between cases with `n`/`p`.

Each `ATC-*.md` / `MTC-*.md` file has a title, preconditions, steps, expected result, and recorded selectors.
Read them like a checklist of what will (ATC) and won't (MTC) be automated.

## Step 5 — Promote a manual case (optional)

Decided an `MTC` case is actually automatable? Promote it to `ATC`:

- **In the TUI:** on the Cases tab, with an MTC case open, press **`a`**.
- **On the CLI:**
  ```bash
  cairn promote --run runs/<id> --cases MTC-LOGIN-001,MTC-LOGIN-002
  ```

Promote renames the file to the next free `ATC-*` number, flips it to automatable, and refills selectors
from the run's data. It does **not** generate code — that's the next step. (If a case has no usable selectors,
add `--session <name>` so it can verify locators live in a browser.)

## Step 6 — Automate and validate

Generate `@playwright/test` code from the approved `ATC` cases, and run them:

```bash
cairn automate --run runs/<id> --validate --session myapp
```

You get `.spec.ts` files under `runs/<id>/tests/`, a pass/fail/flaky report, and automatic repair of
failures (a repair never makes the suite worse).

## …or do it all at once

If you just want the full pipeline without stopping to review:

```bash
cairn explore --url https://app.example.com/page --session myapp
```

This runs design → code → validate → repair → a holistic "Pilot" verdict in one go.

## Guiding what gets tested

- **Checklist:** pass `--checklist plan.md` (a Markdown list of what to cover) to steer the design — copy [`examples/plan.md`](../examples/plan.md) as a starting point.
- **Domain knowledge:** drop `*.md` files in `./knowledge/` (with a `url:` front-matter) to inject
  credentials / validation rules / notes for matching pages.
- **Planning style:** `--style happy | negative | coverage | all`.

## Troubleshooting

- **"session is expired"** — re-run `npm run session:save` for that page.
- **TUI won't start / "Raw mode is not supported"** — run it in a real terminal, not a pipe/CI.
- **Missing-API-key error** — set `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in `.env`.
- **Empty selectors after promote** — the case referenced elements not in the run's `study.json`; re-run
  `promote` with `--session` to verify locators live, or re-`design` the page.

## Where to go next

- [Architecture overview](architecture/overview.md) — how the agent works inside.
- [Architecture Decision Records](adr/) — the locked design decisions (0001–0009).
- The root [README](../README.md) — full command reference and configuration.
