# ADR-0014: The run artifact is a versioned, self-describing contract

- **Status:** Accepted
- **Date:** 2026-07-30
- **Decision in code:** `src/artifacts/contract.ts`, `src/artifacts/report.ts`, `src/artifacts/testcase-md.ts`, `src/agent/{finalize,summary}.ts`, `src/core/modalities/api.ts`
- **Applies from:** 0.7.0 · **PR:** #165
- **Relationship to prior ADRs:** extends ADR-0005 (the *generated tests* are a contract) to the *run artifact* itself. ADR-0005 froze what Cairn writes for a human to run; this freezes what Cairn writes for a machine to read.

## Context

`runs/<id>/report.json` had quietly become Cairn's most important output for anything that is not a
person. The Plune platform reads it — and *only* it — to ingest a run (`plune ingest <dir>`, see Plune's
`ADR-CI-02`, "read `report.json` only, do not depend on the Cairn package"). The TUI reads it. The
`automate` command reads it to find a previous run's cases. The experience tracker reads it to dedupe
against earlier runs.

Three properties a contract needs, and none of them held:

1. **No version.** A change to the shape broke every reader silently and at a distance. Worse, a reader
   could not tell that it was looking at something *newer* than it understood — it just saw a missing key
   and guessed.
2. **The kind of run was inferred, not stated.** The artifact came in four shapes — `explore`, `design`,
   `api`, and the partial one a failed run leaves behind — and only two of them said which they were.
   A reader had to deduce the kind from whichever optional keys happened to be present. That deduction
   starts returning the wrong answer the moment a key becomes optional, which is exactly the kind of change
   nobody thinks of as breaking.
3. **Case identity was positional.** Cases were identified by `tc-3` / `ATC-LOGIN-003` — an answer to
   "which case is this *within this run*". Dedup across runs needs the other question, and we already do
   that dedup ourselves (`--fresh` exists to turn it off). The same case also carried two unrelated
   identities, one in `report.json` and another in its own `.md` file, joined by nothing but array position.

## Decision

**Every run artifact states its version, its kind, and a content-derived identity for each case.**

1. **`schemaVersion`** — `ARTIFACT_SCHEMA_VERSION = 1`, on every shape. Bump it whenever the shape changes
   in a way a reader could notice, and say so in the CHANGELOG. One integer, not semver: readers need
   "can I parse this", not a compatibility algebra.
2. **`mode: "explore" | "design" | "api"`** — on every shape, **including the partial artifact a failed
   run leaves behind**. A failed run is still an artifact someone parses, and it should say what it is
   before a reader decides it is unusable.
3. **`stableId` beside `id`** — a content-derived case identity: `sha256` over the case's normalised
   substance (title, technique, type, expected, steps), NUL-joined so `["ab c"]` cannot hash identically to
   `["ab","c"]`, truncated to 12 hex chars. `id` is untouched, so `promote` and `automate`, which match on
   the `ATC-<suite>-<n>` shape, behave exactly as before.
4. **The derivation lives in one function** (`designedCaseStableId`). Three separate sites mint designed
   cases — the design pass, the critique top-up (ADR-0017), the gap filler — and three copies of the
   formula would drift into three identities for the same case, surfacing only as a broken dedup.
5. **The field is required, not optional.** Making it required is what made the compiler point at the two
   case-minting paths that would otherwise have been missed.

### The known limit, measured rather than assumed

This is **exact-content** identity. It is fully stable for a deterministic generator and not sufficient on
its own for an LLM-designed one:

| Generator | Two runs, same input | Identities shared |
|---|---|---|
| `api` cases (spec-derived, ADR-0015) | 26 cases | **26 / 26**, with the positive and negative case of one operation correctly distinct |
| `design` cases (LLM-designed) | 29 cases | **0 / 29** — the model rewords between runs |

That is still strictly better than what it replaces, and the reason is the whole point: a positional id
produces **false** matches (`tc-3` in one run is a different case from `tc-3` in the next, while looking
exactly like a match). This produces none — it either matches truly or reports that it does not know.
Going from silently-wrong to honestly-unknown is what makes a dedup safe. Closing the remaining gap for
reworded cases is what `design/dedup.ts` `caseSimilarity` already does; a consumer that needs it should
reach for similarity, not for this.

## Consequences

- **Cairn owes downstream a bump.** `report.json` is no longer an internal dump we may reshape freely.
  Any noticeable shape change now costs a `ARTIFACT_SCHEMA_VERSION` bump plus a CHANGELOG line.
- **Plune ingest gets a version gate for free.** It can refuse, warn, or degrade on an unknown version
  instead of parsing a newer artifact with older assumptions.
- **Two identities per case, deliberately.** `id` answers "where in this run"; `stableId` answers "is this
  the same case". Collapsing them into one identifier was the original mistake; keeping both is the fix.
- **Failed runs became parseable.** A partial artifact now says what it is, so a consumer can classify it
  rather than reject it.

## Rejected alternatives

- **Semver the artifact (`"1.2.0"`).** A reader's only real question is "do I understand this shape".
  An integer answers it; a three-part version invites a compatibility policy nobody would implement.
- **Replace `id` with `stableId`.** Would have broken `promote` and `automate`, which match on the
  `ATC-<suite>-<n>` shape, and would have destroyed the "which case is this within this run" answer that
  reports and human review actually use.
- **Make `stableId` optional.** It would have compiled and shipped `undefined` identities from the two
  case-minting paths nobody remembered, surfacing later inside a consumer's dedup.
- **Hash the whole case object, including `elementRefs`.** Grounding detail changes with the page without
  the case becoming a different case; including it would mint a new identity on every re-run.
- **Publish a JSON Schema / TypeScript package for the contract.** Would couple readers to a Cairn release.
  Plune's `ADR-CI-02` explicitly chose not to depend on the Cairn package; a self-describing artifact is
  what lets both sides keep that independence.
