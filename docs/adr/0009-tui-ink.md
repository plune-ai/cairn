# ADR-0009: Interactive TUI on Ink (React-for-CLI)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Decision in code:** `src/tui/`, the no-argument dispatch in `src/cli/index.ts`

## Context

`lex-bot` runs are long and multi-step (observe→…→validate⇄repair, minutes), and the flag-based CLI makes
users memorize options and watch a flat stream of progress lines. We wanted an interactive terminal
experience: pick a command, fill parameters via a form, watch a live dashboard, browse past runs.

## Decision

**A full-screen TUI built with Ink (React-for-CLI)**, launched as the **default when `lex-bot` runs with no
arguments in a TTY**. Constraints honored:

- The TUI lives entirely in `src/tui/` and **only consumes the public API** (`runExploration` / `runDesign` /
  `runAutomate` via `onProgress`). The agent core and `src/index.ts` are untouched; `exports` stays `"."`.
- React/Ink are **lazy-imported** on the TUI path only — non-TUI commands and library embedders never load them.
- Progress drives the live checklist off the **`<node>` prefix only** (message text is localized: run.log UK
  vs graph.ts EN); all numbers come from typed results.
- Non-TTY (pipe/CI) with no args prints help — the TUI never grabs raw mode where it can't.

Runtime deps (in `dependencies`, not peer/optional, so `npm i -g` just works): `ink`, `react@18`,
`ink-select-input`, `ink-text-input`, `ink-spinner`.

## Consequences

- (+) One discoverable entry; long runs get a live node checklist + log + result summary; a past-run browser.
- (+) Additive — zero change to the agent or the frozen library surface; React absent from embedder processes
  (all 102 prior tests stayed green; +23 TUI tests).
- (−) Adds React/Ink to install size; being interactive, it is covered by `ink-testing-library` render tests
  rather than the real-TTY path (raw mode needs a real terminal).

## Review trigger

A second UI surface (e.g. a web dashboard) or a need to cancel mid-run (would require an `AbortSignal` in the
public API) → re-evaluate the contract.

## Rejected alternatives

- **A lightweight prompt wizard (`@clack/prompts`)** — simpler, but no live re-rendering dashboard for the long
  graph run, which is the main value.
- **A separate `tui` subcommand / second bin** — extra surface to remember; if the TUI is the primary UX it
  should be the default, not an opt-in command.
