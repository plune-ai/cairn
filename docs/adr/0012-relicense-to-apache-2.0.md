# ADR-0012: Relicense from GPL-3.0-only to Apache-2.0

- **Status:** Accepted · **Date:** 2026-06-14
- **Decision in code:** `LICENSE` = Apache License 2.0; `package.json` `"license": "Apache-2.0"`; `NOTICE` added.
- **Resolves:** backlog item **L4-01**. **Applies from:** 0.3.0 onward.
- **Relationship to prior ADRs:** GPL-3.0-only was the project's initial *default* and was never recorded in an ADR (ADR-0010 is the rename, not a license decision). This is the first ADR to capture the license choice; the clean-relicense basis (sole copyright over the ported methodology) is established in ADR-0008.

## Context

Cairn ships as an npm package **meant to be embedded as a library** (`import { runExploration } from '@plune-ai/cairn'`) and as a CLI, and it is the open **generation layer** that funnels adoption toward the separately-monetized **Plune** platform (the record/eval layer). The inherited GPL-3.0-only license works against all three:

- **Copyleft brakes the wedge.** GPL-3.0's reciprocal obligations make many companies' legal teams refuse evaluation outright — a hard stop for a bottom-up, developer-led adoption wedge.
- **It poisons the library-embed path.** Importing a GPL library into a larger work extends GPL's "derivative work" reach over the embedding application — exactly the usage we want to encourage. That is a deal-breaker for the funnel.
- **No upside for us here.** Cairn is the generation layer; copyleft would only protect a hosted service, and that concern lives in Plune, not in Cairn.

## Decision

Relicense Cairn to **Apache-2.0**.

## Decision drivers

- Maximize the OSS adoption funnel into Plune (permissive = least friction).
- Keep the library-embed path clean — no copyleft reach into the embedding app.
- Enterprise trust plus an explicit **patent grant**.

## Considered options

- **Apache-2.0 — chosen.** Permissive; clears the embed path; adds an explicit patent grant (§3) and a NOTICE/attribution mechanism enterprises trust. Marginally more ceremony than MIT, which is worth it.
- **MIT.** Permissive and minimal, but **no explicit patent grant**. For a tool that generates and runs code, the Apache patent grant is meaningfully reassuring to enterprise adopters → rejected in favor of Apache-2.0.
- **ELv2 / source-available (BSL-style).** Protects against hosted resale of a *platform*. Rejected: Cairn is the **generation layer**, not a hosted service — there is nothing to wall off, and source-available would reintroduce the very adoption friction we are removing. The monetization boundary lives in Plune.
- **Stay GPL-3.0-only.** Rejected for the reasons in Context.

## Consequences

- **(+)** Companies can embed Cairn as a library and ship products with it without copyleft obligations → wider top-of-funnel for Plune.
- **(+)** Explicit patent grant + NOTICE attribution → easier enterprise sign-off.
- **(−)** No reciprocal "share-alike" — forks may go closed. Acceptable: the moat is Plune (record/eval), not the generator.
- **Scope:** applies to **0.3.0 onward**. Previously published **0.1.x / 0.2.x** npm versions remain GPL-3.0 — published artifacts are immutable; this is expected and fine.

## Validity — due diligence (completed before any license file was changed)

The relicense is valid because the work is **solely copyrighted by the maintainer**:

- **Authors:** `git log` shows only the maintainer (`eleoneks@gmail.com`, under the names *AZANIR* and *Maіevskyi Leonid*) plus the GitHub merge bot — no third-party human contributor whose consent would be required. The ported methodology is from the maintainer's own `AZANIR/qa-skills` (ADR-0008), so its inclusion under Apache-2.0 is the author's to grant.
- **No copyleft contamination:** every production dependency is permissive (MIT / Apache-2.0 / BSD / ISC / Unlicense); the only GPL entry reported by `license-checker` was Cairn itself. No (A)GPL/LGPL dependency is bundled or linked.
