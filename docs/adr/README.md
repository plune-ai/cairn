# Architecture Decision Records — index

**20 records.** All of them live here, in `docs/adr/`, one file per decision, numbered in the order they
were made. There is no second location.

> Verified by command: `ls docs/adr/[0-9]*.md | wc -l` → `20`. If that number and this page disagree,
> the command is right. *Checked 2026-08-02.*

An ADR states what was decided, when, why, and what was rejected. It is not a design doc and not a changelog:
if a change did not close off an option, it does not get one. The second half of this page is the reverse
view — **what shipped without an ADR, and why that was the right call** — because "no ADR" should be a
recorded judgement, not an omission.

Conventions: `NNNN-short-title.md`, next free number, never renumbered. Statuses: `Accepted`, `Superseded by
ADR-NNNN`, `Partially superseded by ADR-NNNN`. A decision that is revised rather than replaced keeps its
number and gains a `Revised:` date in its header (see ADR-0002, ADR-0006).

---

## The records

| # | Decision | Date | Status |
|---|---|---|---|
| [0001](0001-language-and-agent-framework.md) | TypeScript + plain async pipeline (originally LangGraph.js v1) | 2026-06-08 | Accepted · partially superseded by 0013 |
| [0002](0002-llm-anthropic-tiering.md) | Multi-provider LLM layer (Anthropic + OpenRouter + Groq), tier × provider | 2026-06-08 | Accepted · revised 2026-06-13 |
| [0003](0003-browser-gateway-hybrid.md) | Hybrid `BrowserGateway`: playwright-lib PRIMARY + playwright-cli SECONDARY | 2026-06-08 | Accepted |
| [0004](0004-prompts-in-langfuse.md) | Prompts as a versioned artifact in Langfuse, with a local fallback | 2026-06-08 | Accepted |
| [0005](0005-test-output-format.md) | Output is `@playwright/test` — POM + `getByRole` + ARIA assertions | 2026-06-08 | Accepted |
| [0006](0006-observability-langfuse-v5-otel.md) | Observability and self-improvement on Langfuse v5 (OTel), self-hosted | 2026-06-08 | Accepted · revised 2026-06-08 |
| [0007](0007-single-package-not-monorepo.md) | One layered npm package, not a monorepo | 2026-06-08 | Accepted |
| [0008](0008-methodology-port-from-qa-skills.md) | The methodology is ported from `AZANIR/qa-skills` | 2026-06-08 | Accepted |
| [0009](0009-tui-ink.md) | Interactive TUI on Ink (React-for-CLI) | 2026-06-10 | Accepted · Ink optional since 0013 |
| [0010](0010-rename-to-cairn.md) | Rename Lex-Bot → Cairn (product name only) | 2026-06-13 | Accepted |
| [0011](0011-per-role-model-routing.md) | Per-role model routing (worker/reasoner) + per-run cost reporting | 2026-06-13 | Accepted |
| [0012](0012-relicense-to-apache-2.0.md) | Relicense GPL-3.0-only → Apache-2.0 | 2026-06-14 | Accepted |
| [0013](0013-drop-langgraph.md) | Drop `@langchain/langgraph`; telemetry at the LLM layer; Ink optional | 2026-06-19 | Accepted |
| [0014](0014-versioned-artifact-contract.md) | The run artifact is a versioned, self-describing contract | 2026-07-30 | Accepted |
| [0015](0015-api-modality-schema-driven.md) | The `api` modality generates from the spec, not from an LLM | 2026-06-30 | Accepted |
| [0016](0016-integration-surfaces-thin-adapters.md) | MCP, CI/PR bot and `--into-project` are thin adapters over the core | 2026-06-24 | Accepted |
| [0017](0017-opt-in-pipeline-passes.md) | The pipeline grows by opt-in passes; a flag-off run is byte-identical | 2026-06-22 | Accepted |
| [0018](0018-documentarian-page-understanding-cache.md) | Page understanding is an artifact, cached by ARIA fingerprint | 2026-06-29 | Accepted |
| [0019](0019-adversarial-styles-port-taxonomy-not-mechanism.md) | Adversarial styles — port the taxonomy, not the mechanism | 2026-07-01 | Accepted |
| [0020](0020-untrusted-llm-verdicts-and-data-protection.md) | An LLM verdict is untrusted; only self-created data is disposable | 2026-06-23 | Accepted |

Note the dates: 0014 is numbered after 0015–0020 but was decided later. Numbers are assigned when an ADR is
**written**; the `Date` field is when the decision was **made**. Records 0015–0020 were written on 2026-08-02
to cover decisions taken between 2026-06-22 and 2026-07-01 — see the next section for why they were owed.

### Reading order for a newcomer

1. [0013](0013-drop-langgraph.md) — there is no graph framework, just async functions. Everything else assumes this.
2. [0003](0003-browser-gateway-hybrid.md) + [0005](0005-test-output-format.md) — what Cairn drives, and what it emits.
3. [0002](0002-llm-anthropic-tiering.md) + [0011](0011-per-role-model-routing.md) — how a model gets picked for a step, and what it costs.
4. [0014](0014-versioned-artifact-contract.md) — what a run leaves behind, and who reads it.
5. [0012](0012-relicense-to-apache-2.0.md) — why Apache-2.0, and where the monetisation boundary sits.

---

## What shipped between 0013 and today, and whether it needed an ADR

Records stopped at **0013 (2026-06-19)** while releases did not: `v0.4.0 → v0.7.0` is **45 commits, 28 of them
`feat:`**. That gap is what the list below closes. Each entry is a verdict, not a description.

> Verified by command: `git rev-list v0.4.0..HEAD --count` → `45`;
> `git log v0.4.0..HEAD --pretty=%s | grep -c '^feat'` → `28`. *Checked 2026-08-02.*

### Needed one — now written

| Shipped | Date | ADR | Because |
|---|---|---|---|
| `--critique`, `--flow`, `--setup`, `--gaps`; later `--goal`, `--screencast` | 06-22 → 06-30 | [0017](0017-opt-in-pipeline-passes.md) | Six passes could each have become the default. Making them opt-in — with a byte-identical flag-off run — is what keeps regressions attributable and cost predictable. That is a rule, and rules are what ADRs are for. |
| Provenance-checked Pilot verdicts + data-protection guardrails | 06-23 | [0020](0020-untrusted-llm-verdicts-and-data-protection.md) | Establishes that an LLM verdict is an untrusted input and that only self-created data may be deleted. A safety invariant nobody should be able to remove without finding out why it exists. |
| MCP server (`cairn mcp`), CI/PR bot + GitHub Action (`cairn ci`), `--into-project` | 06-24 → 06-25 | [0016](0016-integration-surfaces-thin-adapters.md) | Three surfaces, one rule: a thin adapter over the public core, optional deps, side effects behind an injectable seam. Three parallel implementations was the live risk. |
| Documentarian — cached page-understanding artifact | 06-29 | [0018](0018-documentarian-page-understanding-cache.md) | Introduces cross-run persistent state (`.cairn-cache/`) and an invalidation rule (ARIA fingerprint). A cache with the wrong key is worse than no cache. |
| The `api` modality, API-1…API-10 | 06-30 → 07-01 | [0015](0015-api-modality-schema-driven.md) | A second real modality that deliberately generates **without** an LLM, and reuses the web ATC artifact boundary so Plune needs no second ingest path. Both are choices with rejected alternatives. |
| Adversarial styles (normal/curious/psycho/hacker) | 07-01 | [0019](0019-adversarial-styles-port-taxonomy-not-mechanism.md) | The taxonomy is borrowed from `testomatio/explorbot`, the mechanism explicitly is not — and `hacker`'s IDOR/priv-esc half is knowingly unshipped. A scope cut that needs to stay visible. |
| Versioned artifact contract (`schemaVersion`, `mode`, `stableId`) | 07-30 | [0014](0014-versioned-artifact-contract.md) | `report.json` is what `plune ingest` reads (Plune's `ADR-CI-02`), so its shape stopped being Cairn's internal business. |

### Did not need one, and why

| Shipped | Date | Verdict |
|---|---|---|
| `--fresh` — ignore prior-run experience for clean A/B runs | 06-19 | **No.** An escape hatch on the existing experience tracker. The general rule it obeys is now in ADR-0017. |
| Metrics legend inline in `report.md` / console / README | 06-19 | **No.** Presentation of numbers ADR-0006 already decided to collect. No option was closed off. |
| Externalised prompts + house-style packs (`--style`) | 06-22 | **No.** Extends ADR-0004's local fallback into user-editable files. Worth a `Revised:` line on 0004, not a record. |
| Provider-safe strict JSON schemas for structured invokes | 06-23 | **No.** Provider-compatibility fix inside the ADR-0002 layer. |
| Tiered transient-error recovery for navigation | 06-23 | **No.** Resilience inside `BrowserGateway` (ADR-0003); the seam is unchanged. |
| SPA link-following, per-page crawl snapshots, Windows `EBUSY` cleanup | 06-24 | **No.** Bug fixes in the `--flow` crawler and the validator sandbox. |
| Step timeout (`STEP_TIMEOUT_MS`) + `volume-fast` routing preset | 06-25 | **No.** A third row in the preset table ADR-0011 already defines, plus a timeout wrapper. Worth a `Revised:` line on 0011. |
| Scope-aware knowledge injection (`web` \| `api` \| `all`) | 06-29 | **No.** A directory-and-front-matter convention for `knowledge/`, documented in `docs/configuration.md`. Plumbing ahead of ADR-0015, with no alternative rejected. |
| Dependabot configuration (four commits tuning it) | 06-29 → 06-30 | **No.** Repository housekeeping. |
| Publish job no longer chases `npm@latest` onto an unsupported engine | 07-30 | **No.** CI fix. |

### Known gap, older than this list

The **modality registry** (`src/core/registry.ts`, 2026-06-14, C1-01 / L-G2) — one list of modalities, with
`ui`/`unit`/`docs` shipping as *gated stubs* pulled one at a time by named demand — has no ADR of its own. It
predates this review window and is described in the file's own header, but it is a real structural decision
and the natural next record if anyone touches it.

---

## Elsewhere

Cairn is one of several repositories under `plune-ai`. **Plune** (the private platform) keeps its own ADRs and
its own index; the one that matters at this boundary is its `ADR-CI-02` — *read `report.json` only, and do not
depend on the Cairn package* — which is exactly why [ADR-0014](0014-versioned-artifact-contract.md) exists on
this side.
