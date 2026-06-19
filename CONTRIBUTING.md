# Contributing to @plune-ai/cairn

Thanks for your interest in improving the bot! This guide covers local setup, the
development workflow, and conventions.

## Prerequisites

- Node.js 20+
- An LLM provider key (Anthropic or OpenRouter) for live runs. Unit tests need **no**
  keys — the LLM and browser are mocked.

## Setup

```bash
npm ci
cp .env.example .env              # fill in keys for live runs
npx playwright install chromium   # for integration tests / live runs
```

## Development workflow (TDD)

We practice test-driven development. For any change:

1. Write a failing test first (`tests/unit/*.test.ts`).
2. Make it pass with the minimal code.
3. Refactor while green.

Before committing, everything must be green:

```bash
npm run build          # tsc (strict)
npm run lint           # eslint
npm test               # vitest (unit + integration)
npm run test:coverage  # coverage gate on core logic
```

## Project layout

- `src/agent/` — plain async pipeline (`runExploreGraph` in `graph.ts`) + entry points (`runExploration` / `runDesign` / `runAutomate`).
- `src/browser/` — `BrowserGateway` + backends (import backends **only** through `gateway.ts`).
- `src/observe`, `src/analyze`, `src/design`, `src/codegen`, `src/validate` — the pipeline stages.
- `src/eval/` — deterministic scorers, LLM judge, Pilot supervisor, experiments.
- `src/prompts/local/*.ts` — the methodology prompts (the bot's "brain").
- `src/cli/` — the `cairn` CLI.

## Editing prompts

Three levels (highest priority first):

1. Langfuse versions (production).
2. `./prompts/<name>.md` — local override, no rebuild needed.
3. `src/prompts/local/*.ts` — the built-in defaults.

## Conventions

- TypeScript strict, ESM/NodeNext.
- All code, comments, and generated test cases are in English (`QA_TESTCASE_LANG` can
  override the generated cases' language).
- Locators are user-facing (`getByRole` / `getByLabel` / `getByText`) — no CSS/XPath/testid.
- Browser backends are imported only via `src/browser/gateway.ts` (enforced by ESLint).
- Keep the public API (`src/index.ts`) clean and host-agnostic.

## Pull requests

- Branch from `main`, keep PRs focused.
- Include tests for new behavior; CI (build + lint + coverage) must pass.
- Describe what changed and why.

## License

By contributing you agree that your contributions are licensed under **Apache-2.0**
(see [`LICENSE`](LICENSE)). The methodology prompts were ported from the maintainer's own
`AZANIR/qa-skills` and are included here under Apache-2.0; see
[`docs/adr/0008`](docs/adr/0008-methodology-port-from-qa-skills.md) (provenance) and
[`docs/adr/0012`](docs/adr/0012-relicense-to-apache-2.0.md) (relicense).
