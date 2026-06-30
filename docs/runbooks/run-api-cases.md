# Runbook: run API cases against a base URL (API-3)

> Execute the happy-path cases `cairn api` generates from an OpenAPI spec and assert each response
> (status + schema). Builds on API-1 (ingest) / API-2 (case generation). The rich report is API-4.

## Steps
1. **Generate only (no execution)** — sanity-check the cases first:
   ```
   cairn api --spec ./openapi.yaml
   ```
   → prints the model summary + one happy-path case per operation.
2. **Run + assert** — add `--base-url`:
   ```
   cairn api --spec ./openapi.yaml --base-url https://api.example.com/v1
   ```
   Each case is sent; per case Cairn asserts the **status** matches the declared success code and the
   **response body** conforms to the declared success schema. Any failed assertion → non-zero exit.

## Auth / headers (nothing hardcoded)
- **Config (per run):** `--header "Authorization: Bearer $TOKEN"` — repeatable. Config headers win.
- **Knowledge (#92):** in an `api`/`all`-scope file under `./knowledge/` (e.g. `knowledge/api/auth.md`),
  declare headers in front-matter:
  ```
  ---
  scope: all
  header.Authorization: Bearer ${API_TOKEN}
  header.X-Api-Key: ${API_KEY}
  ---
  ```
  `${ENV}` resolves from the environment, so the **secret lives in env, never in the committed file**.
  An `endpoint:`-keyed file only applies when its key is contained in the base URL.

## Output
- **Evidence:** `runs/api-<id>/api-evidence.json` (override the dir with `--out`) — per-case request +
  response, status/schema verdicts, attempt count. **Sensitive headers are redacted** (`***`).
- **Console:** `N/M case(s) passed`, then a ✓/✗ line per case with the status and any schema errors.

## Robustness
- **Transient faults** (connection reset / timeout / `429` / `5xx`) retry with backoff before failing,
  reusing the tiered-recovery pattern (#90); DNS/refused and `4xx` fail fast (no retry).
- **Per-request timeout:** 30s (an abort counts as transient).

## Do NOT
- Do NOT commit `.env` or any knowledge file containing a literal token — use `${ENV}` placeholders.
- The schema check is structural (happy-path conformance), not a strict contract validator.
