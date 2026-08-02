# Cairn — documentation

Cairn is an autonomous TypeScript agent that studies a running application and generates tests for it:
`@playwright/test` suites and methodology-tagged test cases, over a plain async pipeline
(ADR-0013) on Anthropic Claude / OpenRouter / Groq, with self-improvement via Langfuse.

Package: **`@plune-ai/cairn`** · CLI: **`cairn`** · License: Apache-2.0.
Start at the [root README](../README.md) for the 30-second pitch; this page is the map of everything below `docs/`.

## Where to look

| I want… | See |
|---|---|
| To install it and get a first suite out | [`getting-started.md`](./getting-started.md) |
| To point it at an app behind a login | [`sessions.md`](./sessions.md) |
| To configure providers, profiles and role routing | [`configuration.md`](./configuration.md) |
| To change the house style of generated cases | [`prompts-and-styles.md`](./prompts-and-styles.md) |
| To drive it from a terminal UI | [`tui.md`](./tui.md) |
| To call it from another agent (Claude Code, Cursor) | [`mcp.md`](./mcp.md) |
| To read the run metrics and scores | [`metrics.md`](./metrics.md) |
| To know what a run costs | [`cost.md`](./cost.md) |
| To wire up tracing and experiments | [`langfuse.md`](./langfuse.md) |
| To see it move | [`demo/`](./demo/) |
| **Why it is built this way** | [`adr/README.md`](./adr/README.md) — the decision index |
| How the pieces fit together | [`architecture/overview.md`](./architecture/overview.md) |
| To run a specific procedure step by step | [`runbooks/`](./runbooks/) |

## Architecture

| Document | What it covers |
|---|---|
| [`architecture/overview.md`](./architecture/overview.md) | The system in one page |
| [`architecture/module-map.md`](./architecture/module-map.md) | Which module owns what |
| [`architecture/state-machine.md`](./architecture/state-machine.md) | The pipeline stages and their order |
| [`architecture/browser-gateway.md`](./architecture/browser-gateway.md) | The two browser backends behind one seam |
| [`architecture/self-improvement.md`](./architecture/self-improvement.md) | Scores, judges, datasets, experiments |
| [`architecture/data-contracts.md`](./architecture/data-contracts.md) | The zod schemas that cross module boundaries |

## Runbooks

Operational procedures, each self-contained:
[save a session](./runbooks/save-session.md) ·
[run an exploration](./runbooks/run-exploration.md) ·
[design then automate](./runbooks/design-and-automate.md) ·
[run API cases](./runbooks/run-api-cases.md) ·
[smoke a real site](./runbooks/real-site-smoke.md) ·
[curate a dataset](./runbooks/curate-dataset.md) ·
[run an experiment](./runbooks/run-experiment.md) ·
[promote a prompt](./runbooks/promote-prompt.md).

## Decisions

Locked decisions live in [`adr/`](./adr/) — **19 records**, indexed in [`adr/README.md`](./adr/README.md).
The index also carries the reverse view: which shipped features were judged **not** to need an ADR, and why.

The ones worth reading first:

- [ADR-0013](./adr/0013-drop-langgraph.md) — why there is no graph framework, just async functions.
- [ADR-0014](./adr/0014-versioned-artifact-contract.md) — `report.json` is a public contract with a version.
- [ADR-0012](./adr/0012-relicense-to-apache-2.0.md) — why Apache-2.0 and not MIT or GPL.
- [ADR-0002](./adr/0002-llm-anthropic-tiering.md) + [ADR-0011](./adr/0011-per-role-model-routing.md) — how a model gets picked for a step.

## Directory layout

```
docs/
├─ README.md              ← this file
├─ getting-started.md     ← onboarding
├─ sessions.md · configuration.md · prompts-and-styles.md · tui.md · mcp.md
├─ metrics.md · cost.md · langfuse.md
├─ adr/                   ← Architecture Decision Records (+ README index)
├─ architecture/          ← system design
├─ runbooks/              ← operational procedures
├─ demo/                  ← recorded demo
└─ assets/                ← images
```

Some working documents (the roadmap, sprint plans, task files, prompt specs) are kept local to the
authoring checkout and are not published — see `.gitignore` for the exact list. Nothing on this page
links to them, which is the point.
