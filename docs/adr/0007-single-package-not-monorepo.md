# ADR-0007: One layered npm package (not a monorepo)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision in code:** the `src/` structure, `package.json`

## Context

The bot must be both a CLI and a library for embedding into a working project. The question: one package or a monorepo
(workspace) with several packages.

## Decision

**A single published npm package** `@plune-ai/lex-bot` with two entry points:
- `bin: lex-bot → dist/cli/index.js`
- `main: dist/index.js` (the library API).

Internal boundaries — directories + barrel exports + ESLint `no-restricted-imports` (backends — only through the gateway).
The modules are tightly coupled around a single async pipeline.

## Consequences

- (+) No cross-package version drift; a simpler build/release/embedding.
- (+) A single artifact for the working project.
- (−) Less rigid boundaries than separate packages → we compensate with the lint rule and barrel discipline.

## Review trigger

The appearance of a **second independent consumer application** (e.g. a separate web UI on top of the bot) → re-evaluate
a monorepo/workspace.

## Rejected alternatives

- **A monorepo (pnpm/turbo workspace)** — premature for a single consumer; the overhead > the benefit right now.
