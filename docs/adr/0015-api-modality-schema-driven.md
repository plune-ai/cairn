# ADR-0015: The `api` modality generates from the spec, not from an LLM

- **Status:** Accepted
- **Date:** 2026-06-30 (API-1 landed the decision) — completed 2026-07-01 (API-2…API-10)
- **Decision in code:** `src/api/`, `src/core/modalities/api.ts`, `src/core/registry.ts`, `src/artifacts/testcase-md.ts`, `src/codegen/index.ts`
- **Applies from:** 0.6.0 · **Issues:** #22 (umbrella), #132…#150 · **Slices:** API-1…API-10
- **Relationship to prior ADRs:** the first modality to join `explore` in the registry created by C1-01. Shares ADR-0002/0011 (providers, routing) and ADR-0005 (`@playwright/test` output), and writes through the ADR-0014 artifact contract.

## Context

ADR-0010 renamed the tool to Cairn on the explicit premise that it would be an **umbrella** — "a container
for many modalities, not a label for one". Until 0.6.0 that premise was unpaid: `explore` (UI) was the only
real modality, and `ui`/`api`/`unit`/`docs` were gated stubs that printed a coming-soon notice. A named user
pulled `api`, so it had to be built.

The obvious way to build it was to point the existing machinery at an OpenAPI spec: give the LLM the spec,
ask for test cases. That is what most tools in this space do, and it is wrong here.

An OpenAPI spec is **already the structured artifact** an LLM would be asked to produce. The happy-path
request for an operation follows mechanically from the schema — `example` → `default` → `enum` → type. Asking
a model to do that derivation buys nothing and costs three things: money per operation, non-determinism (the
same spec yields different cases on different runs), and a failure mode where the model invents an endpoint,
a parameter, or a status code that the spec does not declare. For UI exploration an LLM is unavoidable —
there is no machine-readable description of a running page. For an API there is one, and it is the input.

## Decision

**The `api` modality is a deterministic, schema-driven generator.** It becomes a real entry in the modality
registry (`cairn api --spec <path|url>`, parity with `cairn explore`), and it reuses Cairn's existing
boundaries rather than growing a parallel stack.

1. **Ingest** (API-1) — `@apidevtools/swagger-parser` dereferences an OpenAPI 3.x spec (JSON or YAML, file or
   `http(s)` URL, `$ref` including circular) into an internal endpoint model. A malformed or unsupported spec
   fails with a clear message and a non-zero exit, never a crash.
2. **Case synthesis is pure** (API-2, API-8) — one nominal case per operation, values synthesised straight
   from the dereferenced schema; negative and contract-validation cases derived the same way. **No LLM call.**
   Same spec ⇒ same cases. The `StructuredInvoke` seam stays wired for later, genuinely fuzzy slices, so the
   "any LLM use is mockable" requirement holds — vacuously, for now.
3. **Cases are methodology-tagged** (API-5) — each carries an ISO/IEC/IEEE 29119-4 technique plus a per-case
   rationale, the same tagging web cases carry. A case states *why* it exists, not only what it sends.
4. **Cases are emitted through the same ATC boundary as web cases** (API-5) — `runs/api-<id>/testcases/<id>.md`.
   This is the decision that keeps the platform simple: **Plune ingests API cases through the identical path
   as web cases**, not a parallel one. Status on an ATC is provenance-checked — it reads "Passed" only when a
   same-named, positively-asserted result exists, never inferred from the absence of a failure.
5. **Codegen is templating, not generation** (API-7) — `cairn automate --run <dir>` on an `api` run emits
   `tests/api.spec.ts` using `@playwright/test`'s `request` fixture, one test per case. The case already
   carries every field a request needs, so there is nothing to infer. The generated suite does not depend on
   Cairn and runs standalone in CI; `API_BASE_URL` overrides the base per environment.
6. **The runner, coverage and chains stay in the same discipline** — response assertions (API-3), reporting
   into `report.json`/TUI (API-4), spec-vs-tested coverage (API-6), multi-endpoint create→read→update→delete
   scenario chains threading a captured value through a declared OpenAPI `links` expression or a same-named
   response field (API-9), and `multipart/form-data` encoding with real bytes for `format: binary` (API-10).
7. **Print-only until a base URL is given.** Without `--base-url` there is no run directory and no artifacts —
   consistent across API-1…API-10.

## Consequences

- **An `api` run is reproducible and cheap.** Two runs over the same spec produce byte-identical cases —
  which is what let ADR-0014's `stableId` be verified at 26/26 on `api` and 0/29 on LLM-designed cases.
- **The umbrella claim in ADR-0010 is now paid for once.** `unit` and `docs` remain gated stubs; adding one
  is appending a registry entry plus a `run` that consumes the shared core.
- **The LLM budget is unspent here.** An `api` run costs no tokens for generation, so cost reporting
  (ADR-0011) shows near-zero on this modality — expected, not a bug.
- **Spec quality is now the ceiling.** A spec that lies about its own shapes produces cases that faithfully
  test the lie. Coverage (API-6) reports spec-vs-tested, not spec-vs-reality; nothing here detects an
  undocumented endpoint.
- **`--validate` is a no-op on an `api` run.** It is a browser/session concept and stays web-only.

## Rejected alternatives

- **LLM-designed API cases from the spec.** Costs money per operation, breaks determinism, and can invent
  endpoints and status codes the spec never declared. The spec is the structured artifact already.
- **A separate `cairn-api` package.** Contradicts ADR-0007 (one layered package) and would fork the config,
  routing, cost, reporting and artifact layers that this modality reuses unchanged.
- **A parallel artifact/report path for API runs.** Would have forced Plune to grow a second ingest path for
  the same conceptual object. Reusing `testcases/<id>.md` cost less on both sides of the boundary.
- **Generating requests with an HTTP client library of its own.** `@playwright/test`'s `request` fixture is
  already a dependency, already in CI everywhere Cairn's other output runs, and produces a suite the user's
  existing Playwright setup executes without new tooling.
