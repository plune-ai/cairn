# ADR-0010: Rename Lex-Bot → Cairn

- **Status:** Accepted · **Date:** 2026-06-13
- **Decision in code:** package `@plune-ai/cairn`, CLI `cairn` (deprecated `lex-bot` alias), env prefix `CAIRN_`
- **Supersedes the product name only** — the architecture (ADR-0001…0009) is unchanged.

## Context

The tool is about to spread publicly (npm + docs + demo). Before that, the name should carry the
product's actual ambition. Two problems with **Lex-Bot**:

1. **The `-bot` suffix is a me-too pattern.** The adjacent ecosystem is already full of it —
   *Explorbot*, *ApiBot*, *DocBot*. A `…Bot` name reads as "one more single-purpose bot" and fights
   for the same mental shelf, which is exactly the wrong framing for what we're building.
2. **We are not a single-surface bot.** The roadmap is an **umbrella** CLI that generates tests across
   surfaces — UI today; API, unit, and living docs by demand. The name needs to be a container for
   many modalities, not a label for one.

## Decision

Rename the product to **Cairn**.

A *cairn* is a trail of stacked stone markers that proves a path was walked and guides whoever follows.
That is precisely the product metaphor:

> **Cairn — an AI that walks your system and leaves a trail of tests: UI, API, unit, docs.**

Concrete renames (this PR — code side only):
- npm package `@plune-ai/lex-bot` → **`@plune-ai/cairn`**.
- CLI command `lex-bot` → **`cairn`**; `lex-bot` stays as a **hidden, deprecated alias** that prints a
  one-line notice and runs the same code path (removal planned in 1–2 releases).
- Env prefix → **`CAIRN_`** (resolution order `CAIRN_` → legacy `LEXBOT_`/`LEX_` → bare name; legacy
  prefixes warn once).

### Naming alternatives considered

- **Nib** — short, evocative (pen nib → "writes" tests). **Ruled out:** a live npm package already owns
  `nib`, and `.nib` collides with Apple Interface Builder bundles — a present, not dormant, collision on
  both the registry and the filename namespace.
- **Keep `Lex-Bot`** — rejected: the `-bot` me-too problem above, and it under-sells the umbrella scope.
- **Cairn** — **chosen.** The npm/name collision risk is *dormant* (no significant conflicting package),
  and the "trail of markers left by walking the terrain" metaphor maps cleanly onto a multi-surface,
  evidence-leaving test generator.

## Product boundary (framing, not a build dependency)

- **Cairn = the generation layer** — it walks a system and *produces* tests across surfaces.
- **Plune = the record / management / eval layer** — it *stores, manages, and evaluates* what Cairn (and
  humans) produce.

Cairn is self-contained: it has **no build/runtime dependency** on any Plune-side config. The boundary is
about product scope and messaging, so neither side grows into the other's responsibility.

## Consequences

- (+) The name scales to the umbrella roadmap (`cairn ui|e2e`, `cairn api`, `cairn unit`, `cairn docs`).
- (+) Full backward compatibility: old CLI name, old package (kept published, never deleted — see C0-07),
  and old `LEX_`/`LEXBOT_` env vars all keep working, each with a deprecation nudge.
- (−) A migration window where two package names and two CLI names coexist; mitigated by `npm deprecate`
  on the old package and the in-CLI deprecation notice.
- (−) Docs, demo asset, and social/preview metadata must be refreshed (tracked under epic C0).

## Out of scope for this ADR / PR (manual, maintainer-run)

- Renaming the **GitHub repository** `plune-ai/lex-bot` → `plune-ai/cairn` (C0-01, #11).
- **npm publish** of `@plune-ai/cairn` + `npm deprecate @plune-ai/lex-bot` (C0-07, #17).
- Repo **metadata / social-preview** (C0-08, #18).
