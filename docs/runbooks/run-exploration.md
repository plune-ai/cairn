# Runbook: running a page exploration

> **Status:** stub (filled in over S1–S4) · the command appears incrementally

## Prerequisites

- `.env`: `ANTHROPIC_API_KEY` and/or `OPENROUTER_API_KEY`; `LANGFUSE_BASE_URL` (**the user's self-hosted instance**),
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`; `LLM_PROFILE` (see `.env.example`).
- (Opt.) a saved session — see [`save-session.md`](./save-session.md).
- (Opt.) a checklist file.

## Basic run

```bash
cairn explore --url https://app.example.com/login \
  --session demo \           # storageState name (opt.)
  --backend lib \            # lib | cli (default lib)
  --profile openrouter \     # anthropic | openrouter | mixed (default anthropic; OpenRouter — economical)
  --checklist ./checklist.md # (opt., from S4)
```

## Providers / cost (ADR-0002)

- `--profile anthropic` — quality (Opus/Sonnet/Haiku), more expensive.
- `--profile openrouter` — economical (DeepSeek/Qwen). ⚠️ if the reasoning model has no vision (DeepSeek) →
  `identifyElements` automatically runs in **aria-only** mode (no screenshot).
- `--profile mixed` — e.g. vision on Anthropic-Haiku, bulk+judge on OpenRouter (a price/quality balance).
- The exact model ids of the profiles are in the config; confirmed by Spike S6.

## Checklist format (from S4)

```markdown
# Checklist: Login
- [ ] validation of empty fields (area: form, priority: high)
- [ ] an incorrect password shows an error (area: auth)
- [ ] "remember me" persists the session
```

## Result

`./runs/<runId>/`:
```
tests/        # generated *.spec.ts, page objects, fixtures, *.aria.yml
snapshots/    # screenshot.png, aria.yaml
study.json    # PageStudy
report.json   # ValidationReport + scores, deadClicks
report.md     # the same for a person, with a Dead clicks section: clicks with no change seen, to check by hand
overlays.json # dialogs, drawers, menus and wizards found as states: trigger, exits, elements, wizard steps; lib backend
              # guard + blocked: the requests stopped while exploring them, by method (an app may also read through POST);
              # note: why exploring did less than usual. Presses happen in a throwaway browser that lets out nothing but
              # GET/HEAD/OPTIONS and is killed with the guard on, so nothing it did can reach the server later. One
              # exception, on --channel: the browser's own Reporting API report, not the app's doing and not in blocked.
              # Not seen: a WebSocket message, a GET that changes the server. Not checked: Network Error Logging
requests.json # requests the clicks started: method, path, status (no bodies, headers or query values); lib backend
openapi.derived.json # OpenAPI draft from the app's API traffic (#229); lib backend, when any API request was seen
```

`openapi.derived.json` (#229) folds the API requests the run saw — while pages loaded and after each click — into
OpenAPI 3.0: ids in paths become parameters (`/projects/123` → `/projects/{id}`), with methods, response codes and body
schemas inferred from the examples, all marked `x-cairn-derived: true`. Only `--url`'s origin is kept, plus those given
with `--api-origin https://api.example.com` (comma-separated, no `*`, no user or password); analytics, CDNs, pages,
scripts, styles, images and fonts stay out (the run log counts them and names up to three of the origins refused, so a
`--url` that redirects to `www.` or `https` shows what to pass), and so do answers a service worker made itself, which the
log does not count. What the throwaway browser reads while it presses overlays stays out too: only the crawler's own
context records. The host and the port are not in the file: `cairn api` takes the address from `--base-url`.

A string from the traffic reaches the file only after passing a fixed form, which leaves out most free text and
random-looking text but not all of it. A name (a JSON key, a form field, a query name) must match
`^[A-Za-z_][A-Za-z0-9_-]{0,63}$` and not read as random (long hex, letters that flip case, digits in three places). A word
of a path must be ASCII letters with digits only at the end of a `-`/`_` part, up to 32 characters, not 6 or more hex
characters and not shaped like a credential. Both may have at most 4 `-`/`_` parts, at most 3 digits at the end of a part
and at most one part of 4 or more characters that are all hex; from 8 letters on, at least one letter in five must be a
vowel (`y` counts) and the case may turn from lower to upper at most 3 times. A name that fails is left out alone, so
`user.name` and `filter.status` are left out too; a word that fails is a parameter. An object most of whose keys fail, with
many keys of one shape, or with 8 or more keys whose values all have one non-scalar shape is a map
(`additionalProperties`). Bodies, headers, cookies and query values are not written as such.

A secret reaches the file neither as a word of a path, nor as a run of whole parts of a word, nor as a name. These count
as secrets: the value of a header, query, form or body field whose name has `authorization`, `cookie`, `api key`, `token`,
`secret` or `password` in it; every cookie; and the run's own secrets (knowledge, environment). A value under 4 characters,
one equal to its field's name and a word of the document's vocabulary (`string`, `true`, `password`) are not. The comparison
ignores case, letter width, spaces, `-`, `_`, `+`, zero-width characters and soft or non-breaking hyphens, takes a cookie
without its quotes or its signature, and splits camelCase: `resetOpenSesame` holds `open-sesame`, and a secret `admin` leaves
`administrators` alone.

A word of a path with several parts (`jane-roe`, also as `jane_roe` or `janeRoe`) that equals a value the run read, compared
the same way, is a parameter; an address counts by its local part too. The run reads values of up to 256 characters from
JSON bodies up to 1 MB, query strings, url-encoded forms, text bodies and headers. It does not see values in JSON keys, in CSV
or other answers that are not JSON, in answers over 1 MB or in multipart bodies. A word of one part (`projects`, `v1`) is
compared with secrets only, since no value tells it from a route. Three or more distinct words in the same place of a path,
with the same places before them and the same ending that holds a literal word, are parameters: `/api/alice/profile`,
`/api/bob/profile` and `/api/carol/profile` become `/api/{id}/profile`, and `/api/projects/export`, `/api/teams/export` and
`/api/users/export` become the one route `/api/{id}/export`. The end of a path does not fold, and neither does a word with
only parameters after it: `/api/projects/1`, `/api/users/2` and `/api/teams/3` stay apart.

Limits: a one-word slug stays, even when an answer names it (`/api/users/alice` with `{"username":"alice"}`); a list of names
at the end of a path stays (`/api/users/alice`, `/api/users/bob`, `/api/users/carol`); a sentence or a person's name of up to
four parts keeps the form (`alice_smith_hiv_positive`); and a plain word used as a key, a form field or a query name stays
unless it is or holds a secret. Read the draft before sharing it.

A JSON response is parsed for its schema and its values and not kept: one that says it is over 1 MB is not read, and one
with no `content-length` is read whole and dropped if it is over 1 MB. A response body still open 3 s after the run ends
(a long poll, a watch stream) is cut off: the request stays, without a schema, and the run log counts it. A failed write
goes to the log and the run goes on. Past 1 000 000 distinct values the run writes no file, because it could no longer
check it, and the log says why. Give the file straight to `cairn api --spec runs/<runId>/openapi.derived.json --base-url <url>`.
The sign-in of an `--env-file` environment runs in its own browser and is not recorded.
+ a Langfuse trace (link in stdout).

## Diagnostics

| Symptom | Where to look |
|---------|---------------|
| tests red | `report.json` → `results[].error`; the ARIA snapshot |
| hallucinated locators | the `grounding` score; the `identifyElements` node trace |
| no trace | telemetry bootstrap / `LANGFUSE_*` (Spike S5) |
