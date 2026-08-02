# ADR-0018: Page understanding is a first-class artifact, cached across runs by ARIA fingerprint

- **Status:** Accepted
- **Date:** 2026-06-29
- **Decision in code:** `src/documentarian/index.ts`, `src/agent/graph.ts`, `src/artifacts/index.ts`
- **Applies from:** 0.6.0 · **Issue:** #93 (BORROW-06) · **PR:** #116
- **Relationship to prior ADRs:** adds a cross-run cache to ADR-0013's pipeline. Cross-run *semantic* memory (MEM-02, #64) is deliberately out of scope and remains unbuilt.

## Context

Every run re-learned the page from zero. Observe, identify elements, verify locators, probe interactions —
then a `analyzePage` LLM call to turn all of that into an understanding of what the page *is*. Run the same
command twice against the same unchanged page and Cairn paid for that grounding call twice, having thrown
away an answer it had already computed.

Two things were wrong, and only one of them is about cost:

1. **The understanding was not an artifact.** It existed as intermediate state inside a run and vanished with
   it. A human reviewing a run could see the cases and the code, but not the interaction map the agent had
   built to design them — which is the artifact that explains *why* those cases and not others.
2. **It was recomputed unconditionally**, with no notion of whether anything had changed.

The naive fix — cache by URL — is worse than no cache: the page behind a URL changes, and a stale
understanding produces cases grounded in elements that no longer exist. Any cache here needs an
invalidation signal that is actually correlated with what the understanding depends on.

## Decision

**A run emits a `page-understanding.json` artifact and caches it across runs, keyed by URL plus a fingerprint
of the page's ARIA snapshot.**

1. **The understanding is a first-class artifact** — `runs/<id>/page-understanding.json`: a strict-schema
   interaction map, element → locator + container + candidate actions, alongside the page's semantics.
2. **It is assembled deterministically** from outputs the run already has (observe, verify, probe). The
   documentarian introduces **no additional LLM call** — it structures what was computed anyway.
3. **The cache key is `url` + page fingerprint, where the fingerprint is a hash of the ARIA snapshot.** This is
   the load-bearing choice: the understanding is a map over ARIA refs, so *same ARIA ⇒ same refs ⇒ the cached
   understanding is still valid*. The invalidation signal is the same thing the artifact is derived from,
   rather than a proxy like a timestamp or an ETag.
4. **A hit skips the ground call.** A second run on an unchanged page reuses the cached understanding and
   skips `analyzePage` — fewer observe/ground calls, same output. A changed page misses (the fingerprint
   differs) and re-grounds. That is deliberate invalidation, not a cache failure.
5. **The cache lives outside the run** — `.cairn-cache/understanding`, gitignored, cross-run and cross-command.
6. **`--fresh` bypasses it**, consistent with what `--fresh` already means for the experience tracker: ignore
   prior-run state for a clean A/B.
7. **A cache write failure never breaks a run.** Best-effort persistence, in line with ADR-0017's rule for
   auxiliary passes.

## Consequences

- **Repeat runs on a stable page are cheaper and faster** without any change to what they produce.
- **A reviewer can read what the agent understood**, separately from what it generated — the missing middle
  artifact between the screenshot and the test case.
- **The fingerprint is conservative in the right direction.** A cosmetic ARIA change (a re-ordered list, a
  changed label) invalidates the cache even though the understanding might still have been valid. Re-grounding
  unnecessarily costs one call; using a stale map costs a wrong test suite.
- **The cache is a local directory, not shared state.** Nothing is coordinated between machines or CI runs;
  a cold CI environment always misses. Fine for the current cost profile, and the reason a real cross-run
  memory (MEM-02) is still a separate, unbuilt thing.
- **`.cairn-cache/` is now a directory Cairn owns on the user's disk.** It is gitignored and safe to delete;
  deleting it costs one grounding call on the next run.

## Rejected alternatives

- **Cache by URL alone.** Fastest to write and actively harmful: a changed page silently yields an
  understanding grounded in elements that are gone.
- **Cache by DOM/HTML hash.** Far too sensitive — a session token in a `data-` attribute or an ad slot
  invalidates on every load, which is a cache that never hits. ARIA is both stabler and closer to what the
  understanding is actually made of.
- **Time-based expiry (TTL).** Time is uncorrelated with page change; a TTL either serves stale maps or
  discards valid ones, tuned by guesswork.
- **An extra LLM call to summarise the page into the artifact.** The point was to spend fewer calls, not to
  add one for a document. Deterministic assembly from existing outputs gives a strict-schema artifact for free.
- **Storing the understanding only inside `report.json`.** It is consumed independently (cache lookup, human
  review) and would have bloated an artifact that ADR-0014 later froze as a contract.
