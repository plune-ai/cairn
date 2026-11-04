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
with `--api-origin https://api.example.com` (comma-separated); analytics, CDNs and pages, scripts, styles, images and
fonts stay out (the run log counts them). No body, header, cookie or query value is written, only names, types and
status codes, and the traffic's credentials are scrubbed from the file as well. An e-mail address in a path becomes a parameter, and an
object keyed by e-mail addresses or tokens is a map (`additionalProperties`). A response body still open 3 s after the
run ends (a long poll, a watch stream) is cut off: the request stays, without a schema, and the run log counts it. Give it straight to
`cairn api --spec runs/<runId>/openapi.derived.json --base-url <url>`. The sign-in of an `--env-file` environment runs
in its own browser and is not recorded.
+ a Langfuse trace (link in stdout).

## Diagnostics

| Symptom | Where to look |
|---------|---------------|
| tests red | `report.json` → `results[].error`; the ARIA snapshot |
| hallucinated locators | the `grounding` score; the `identifyElements` node trace |
| no trace | telemetry bootstrap / `LANGFUSE_*` (Spike S5) |
