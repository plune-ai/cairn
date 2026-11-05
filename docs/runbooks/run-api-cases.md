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
3. **No spec file? Let the server give it (#227)** — leave out `--spec`:
   ```
   cairn api --base-url https://api.example.com/v1
   ```
   Cairn tries `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/v3/api-docs`, `/v2/api-docs`, `/api-docs`,
   `/swagger/v1/swagger.json` and `/docs/openapi.json` on the base URL, in that order, and uses the first answer that
   reads as an OpenAPI 3.x spec; the output says where (`✓ OpenAPI spec found at …`) and the run goes on as if that
   spec had been given. The eight lookup requests are `GET` only, with no body, and give up after 5 s each; they count
   against `--max-requests` and `--rps`, do not follow redirects, and send the same headers as the run (below). A path
   that `--allowed-paths` does not allow is skipped, not requested. A found spec's external references are not
   followed: a served spec whose `$ref` points at a file or another address is not used
   (`external $ref is not followed for a spec found on the server`) and the next path is tried. The addresses go on the
   base URL's path and keep its query string, so with `--base-url https://host/api?key=k` the first try is
   `https://host/api/openapi.json?key=k`. A spec behind a sign-in is reached with `--header` (for example a `Cookie:`
   header) or the api-scope credentials. Nothing found → exit `1` (`4` when the request budget ran out first) with
   every address tried and its answer, and every address skipped; pass `--spec <path|url>` then.

4. **A Postman collection or a HAR instead of a spec (#228)** — give it to `--spec` as a local file:
   ```
   cairn api --spec ./collection.postman.json --out runs/api-1
   cairn api --spec ./recorded.har --base-url https://staging.example.com
   ```
   The format is told from the content (a Postman collection v2.x, a HAR's `log.entries`; anything else is read as
   OpenAPI, as before). It is converted to OpenAPI 3.0 and saved as `openapi.derived.json` in the run directory
   (`--out`, else `runs/api-<id>/`), and the run reads that file as if it had been given. Ids in a path become
   parameters (`/projects/123` → `/projects/{id}`; in a collection `:id` and `{{id}}` keep their name), body schemas are inferred
   from the request and response examples, and every operation and inferred schema is marked `x-cairn-derived: true`:
   trust it less than a written spec. From a HAR only the API requests of the origin most of them went to are kept;
   pages, scripts, styles, images and fonts are left out, and the output counts what was. Header, cookie, query and
   body values are not written as such.

   A HAR follows the rules for recorded traffic (`run-exploration.md`) and keeps its host: a word or a name outside the
   fixed form is a parameter or left out (`user.name`, `filter.status`), a word of several parts equal to a value seen is a
   parameter, and three or more words in one place before a literal word fold into one (`/api/{id}/export`). A collection
   keeps what a person wrote: its paths, `:id`, `{{id}}` and query names in any form (`?verbose`, `page[size]`, `$top`), with no
   fold by a value or by position; digits, a credential-shaped word and an address in a path are parameters, and the keys of
   its bodies and examples pass the name form.

   In both, a secret reaches the file neither as a word of a path, nor as a run of whole parts of a word, nor as a name.
   These count as secrets: the value of a header, query, form or body field or variable whose name has `authorization`,
   `cookie`, `api key`, `token`, `secret` or `password` in it; every cookie; the user and password of a URL; a value shaped
   like a credential (a JWT, long hex) or that the run's secret reader takes from a `name: value` pair; and the run's own
   secrets. The comparison ignores case, letter width, spaces, `-`, `_`, `+`, zero-width characters and soft or non-breaking
   hyphens, and splits camelCase. Limits: in a HAR a one-word slug and a list of names at the end of a path stay, in both a
   plain word used as a key or a query name stays unless it is or holds a secret, and a collection's paths stay as written, so
   read the draft before sharing it. The name of a collection, a request or a folder is written as it is, and dropped whole
   when it holds a secret as a run of whole parts. A
   Postman v1 collection is refused: export it as v2.1.

## Save scenario chains as API flows (`--save-flows`, #230)
`cairn api --spec ./openapi.yaml --scenarios --save-flows flows.json` saves each chain that has a `DELETE` as an API
flow: its create step, the id the `DELETE` needs, and the `DELETE` as the cleanup. `cairn api --flows flows.json --out
e2e/fixtures` then writes a Playwright fixture module (`api-flows.fixture.ts`) that UI tests import to get that data
and have it deleted after the test, also after a failed one. Neither sends a request. A flow that changes data runs
only against an address given with `--base-url <url> --allow-mutations` (or `CAIRN_ALLOW_MUTATIONS=<origin>` when the
tests run); otherwise the tests that use it are skipped. The file format, the sign-in flow and how `design` and
`automate` use the flows: **[API flows](../api-flows.md)**.

## Two-actor check: IDOR and privilege escalation (`--actors`, #233)
`cairn api --base-url <staging> --actors actors.json --allow-mutations` reads `actors.json` (the flow file it names,
two actors, the checks; format in the [README](../../README.md#api-security-idor-and-privilege-escalation-across-two-actors)).
For each check the owner runs the data flow, then the other actor sends `GET`, the change (default `PATCH {}`) and
`DELETE` to the resource, and `GET` to the ids next to a numeric id (`neighbours`, default 2 on each side). A 2xx to the
other actor is a finding: `WSTG-ATHZ-04` for another user (`"role": "peer"`), `WSTG-ATHZ-03` for a lower role
(`"role": "lower"`); a neighbour is a `WSTG-ATHZ-04` finding only when the owner can read it too. Only `401`, `403`
and `404` mean refused. Any other non-2xx — a `3xx`, `400`, `405`, `410`, `422`, a `5xx` — is inconclusive, not a pass:
a `PATCH {}` refused by validation, or a redirect to a login page, says nothing about the access check. The same holds
for the owner's answer on a neighbour the other actor read. When every answer the other actor got within a check is a
`401`, those cases are inconclusive too: its credentials may not be valid, so access was not checked. A `401` next to
any other answer stays refused. The other actor's requests carry no identity but its
own actor definition. From the flow file it takes only `Accept`, `Accept-Language`, `Content-Type` and `User-Agent`;
its own headers and session cookie come from `actors.json`. Header names merge case-insensitively, so one name carries one value. What is known in advance is checked before the first request: the actors' headers, every header name in the
flow's steps and cleanup, and every `{{env.NAME}}` in their paths, queries, bodies, forms and headers, which must be set,
must be able to stand in a path where it is in one, and must have characters a header can carry where it is in one. So
the flow creates nothing its cleanup is already known not to be able to send. What a captured value holds is checked
when it is sent. A check refused before its first request has no cleanup. Otherwise the flow's cleanup runs as the owner
in a `finally`, also when a request fails halfway; a request fetch itself rejects counts as sent, so it can report a
cleanup error though nothing reached the server. A cleanup step without `expect` is done only on a 2xx (a `302` to a
login page after the owner's session ended is a cleanup error naming the method, path and status); only after the
other actor's `DELETE` went through does a `404` or `410` from it count as done. A cleanup step whose value was never
captured (the create answered without the id) cannot be sent and is reported as a cleanup error naming the resource
and the missing value. A captured JSON whole number past 2^53 stops the check, naming the capture: it may
have been rounded, and a read or a cleanup must not reach another record. A string id above 2^53 is used as written, and
its neighbours are skipped. Run it against a disposable staging
environment only: without `--allow-mutations` nothing is sent (exit 5); a check whose flow or cleanup
`--allowed-methods`/`--allowed-paths` refuse, or that the remaining `--max-requests` budget cannot cover, is not
started; a probe they refuse is listed as skipped. Output: one line per case with its WSTG id, the Guardrails section,
and `two-actor.json` in `--out`. A captured value is shown there only as a whole number in the path, and not when it
equals the value of an `{{env.NAME}}` that the flow file or `actors.json` names; everything else stays as written,
`{{name}}`, `{{env.NAME}}` and the whole query, and the real values go only on the wire. A neighbour shows its computed
number, unless that number equals such a value or the id it was computed from is not shown. So a secret from the
environment never reaches the report or the terminal, with two known limits: a whole number the server answered is shown
unless it equals a value a file names, so a number that is a secret or part of one can be shown when neither file names
that exact value (`007` echoed as `7`); and a neighbour hidden because it equals a named value, next to an id that is
shown, tells what that value is.

Exit codes, the first that applies wins: `1` for a two-actor file or saved session that cannot be used, a finding, an
inconclusive case, a check that stopped, a cleanup that failed, or a check `not tested` (it ran with no probe answered,
or `--allowed-methods`/`--allowed-paths` refused its flow or cleanup) while another check got an answer; `4` for a check
not started because the budget could not cover it; `5` when no probe in the run got an answer, because nothing was
tested (the owner's own requests do not count); otherwise `0`. A probe skipped next to answered ones (a UUID id skips
`neighbours`, `--allowed-methods` narrows a probe) stays a pass, counted in the summary line.

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
reason, blocked, redirects not followed, and the budget used; after a spec lookup on the server (step 3) also the lookup's
own requests (`spec lookup: N requests`, already in the budget), and in `report.json` what each address answered. Not-sent cases are not test failures.

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
