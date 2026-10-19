# Runbook: run API cases against a base URL (API-3/API-4)

> Execute the happy-path cases `cairn api` generates from an OpenAPI spec and assert each response
> (status + schema). Builds on API-1 (ingest) / API-2 (case generation). The rich report + run
> summary/TUI integration is API-4.

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
   By default only `GET`/`HEAD`/`OPTIONS` cases are sent; the mutating ones are listed as
   `skipped: mutations disabled`. To run the whole suite against an environment you own, add `--allow-mutations`
   (see **Guardrails** below):
   ```
   cairn api --spec ./openapi.yaml --base-url https://staging.example.com/v1 --allow-mutations
   ```
   If every case ends up skipped or blocked the run exits `5` (nothing was tested). Each case that is sent; per case Cairn asserts the **status** matches the declared success code and the
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
- **Console:** `N/M case(s) passed`, then a ✓/✗ line per case with the status and any schema errors,
  then the **shared run-summary footer** (same renderer as web runs) — `Operations: N/M passed · K
  endpoint(s) covered`, the evidence path, and the artifacts dir.
- **Report + TUI (API-4):** `report.json` + `report.md` are written next to the evidence file, in the
  same shape/location web runs use — so `cairn` (no args) → **Past runs** lists the api run too, with
  pass/fail + endpoint coverage instead of green%/pilot, and its Report tab shows the per-operation
  table + a link to `api-evidence.json`.

## Coverage gate for CI (`--min-coverage`)
`cairn api --spec ./openapi.yaml --min-coverage 80` fails the run when fewer than 80% of the spec's
operations are `covered` (covered operations / all operations). `partial` operations are not counted
unless you add `--count-partial`. Works with or without `--base-url`: coverage is spec-vs-generated cases.

- **Report:** a `=== Coverage gate: … — n / N operation(s) covered = P% (min M%) ===` line, followed on
  failure by every operation that was not counted (uncovered, and partial unless `--count-partial`; status, method, path), so the reason is visible in the log.
- **Exit codes:** `0` ok, `1` failed tests or bad input (including a `--min-coverage` outside 0..100 or not a
  number; the message is printed and the exit code is 1), `3` coverage below the threshold. An empty spec passes at 100%. With `--base-url` the verdict is also in `report.json` (`coverageGate`) and `report.md`. When tests also fail, `1` wins.
- **GitHub Action:** set `api-spec` with `min-coverage` (and `count-partial`) — see `action/README.md`.
- Without the flag nothing changes.
## Guardrails (what a `--base-url` run may do)
A bare `cairn api --spec ... --base-url <url>` is safe by default: it cannot change data on the target, leave
the host or flood it. Loosen only what you need, and only against an environment you own.

| Flag | Default | Effect |
|---|---|---|
| `--allow-mutations` | off | Send `POST`/`PUT`/`PATCH`/`DELETE`. Off: those cases are still generated and listed but reported `skipped: mutations disabled` (with their count); `GET`/`HEAD`/`OPTIONS` run. The `psycho` and `hacker` adversarial styles are skipped entirely without it. |
| `--allowed-methods <list>` | all | Comma-separated methods that may be sent (`GET,HEAD`). Others: `skipped: not allowed`. |
| `--allowed-paths <list>` | all | Comma-separated spec-path masks (`/pets/*,/health`; `*` = one segment, `**` = any depth), matched against the path as written in the spec. Others: `skipped: not allowed`. |
| `--max-requests <n>` | 300 | Budget for the whole run; every send counts, retries on `429`/`5xx` included. When it runs out the rest are `skipped: budget exhausted` and the exit code is `4`. |
| `--rps <n>` | 5 | Requests per second for the whole run, whatever the concurrency. |

Always on, no flag:
- **Host pinned.** Requests go to `--base-url` only; absolute URLs in the spec's `servers` are ignored.
- **No redirects.** A `3xx` is not followed; it is recorded (status and `Location`) in the case result and the guardrail report.
- **Path parameters.** A value that is, or decodes to, a `.`/`..` segment (`../admin`, `%2e%2e/admin`, `..%2Fadmin`) is refused
  (`blocked`) because it would leave the base path. Payloads inside a value (`' OR '1'='1`, `<script>`, `//x`) are still sent, encoded.
- **Secrets masked.** Values of `Authorization`/`Cookie`/`*key*`/`*token*`/`*secret*`/`*password*` headers (and the credential after
  `Bearer `) are replaced with `***` in the console, evidence, `report.json`, `report.md`, the case docs and in response bodies
  that echo them.

The run ends with a `Guardrails` section (also in `report.json` under `guardrails` and in `report.md`): cases executed, skipped by
reason, blocked, redirects not followed, and the budget used. Not-sent cases are not test failures.

Exit codes: `0` ok, `1` a test failed or the input was bad, `3` `--min-coverage` not reached, `4` the request budget ran out, `5` every case was
skipped or blocked, so nothing was tested. When several apply, the first of 1, 3, 4, 5 wins. Only `GET`/`HEAD`/`OPTIONS` count as read-only; any other method (`TRACE`, `PURGE`,
a custom verb, lower-case `post`) needs `--allow-mutations`. On a read-only run, `X-HTTP-Method-Override`-style headers and a
`_method` query parameter are removed from requests, whatever supplied them. **Coverage and `--min-coverage` with `--base-url`:** coverage is computed from what was actually sent, so a case that was skipped or blocked does not
count as covering its operation. A run without `--allow-mutations` therefore shows its mutating operations as uncovered and `--min-coverage`
can fail (exit 3) on it; add `--allow-mutations` against a disposable environment or lower the threshold. `--base-url` must be an absolute `http(s)` URL; credentials in it (`https://user:pass@host`) are
sent as a Basic `Authorization` header, not in the URL, and masked everywhere. `--rps` must be at least 0.01.

**Warning.** `--allow-mutations` creates, changes and deletes real data, and the adversarial styles send hostile input.
Do not point it at production or at a shared environment (staging used by others, a shared demo database). Use a disposable
environment, and keep `--max-requests`/`--rps` low for anything you do not own. Without `--base-url` nothing is sent at all.

## Robustness
- **Transient faults** (connection reset / timeout / `429` / `5xx`) retry with backoff before failing,
  reusing the tiered-recovery pattern (#90); DNS/refused and `4xx` fail fast (no retry).
- **Per-request timeout:** 30s (an abort counts as transient).

## Do NOT
- Do NOT commit `.env` or any knowledge file containing a literal token — use `${ENV}` placeholders.
- The schema check is structural (happy-path conformance), not a strict contract validator.
