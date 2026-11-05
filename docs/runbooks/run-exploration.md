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
requests.json # requests the clicks started: method, path, status (no bodies, headers or query values); lib backend
openapi.derived.json # OpenAPI draft from the app's API traffic (#229); lib backend, when any API request was seen
```

`openapi.derived.json` (#229) folds the API requests the run saw — while pages loaded and after each click — into
OpenAPI 3.0: ids in paths become parameters (`/projects/123` → `/projects/{id}`), with methods, response codes and body
schemas inferred from the examples, all marked `x-cairn-derived: true`. Only `--url`'s origin is kept, plus those given
with `--api-origin https://api.example.com` (comma-separated, no `*`, no user or password); analytics, CDNs, pages,
scripts, styles, images, fonts and answers a service worker made itself stay out (the run log counts them and names up
to three of the origins refused, so a `--url` that redirects to `www.` or `https` shows what to pass). The host and the
port are not in the file: `cairn api` takes the address from `--base-url`.

A string from the traffic reaches the file only in a fixed form. A name (a JSON key, a form field, a query name) must
match `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`, not be long random text and not be, or hold as a whole `-`/`_` part, a secret of
the run or a credential of the traffic; one that fails is left out alone, so `user.name` and `filter.status` are left out too. An object most of whose
keys fail, or with many keys of one shape, is a map (`additionalProperties`). A word of a path stays only as ASCII letters
with digits at the end of a `-`/`_` part, up to 32 characters, not 6 or more hex characters and not equal to any value the traffic showed or a
secret of the run, with no whole `-`/`_` part equal to a secret or a credential; anything else is a parameter. Bodies, headers, cookies and query values are not written as such, but no
form tells a value from a word of the API:
a plain word in a path stays as written when it appeared nowhere else in the traffic, unless three or more such
words sit in the same place before the same ending, and a plain word used as a key, a form field or a query name
stays unless it is or holds a secret of the run or a credential of the traffic, so read the draft before sharing it.

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
