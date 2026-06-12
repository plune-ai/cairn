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
report.json   # ValidationReport + scores
```
+ a Langfuse trace (link in stdout).

## Diagnostics

| Symptom | Where to look |
|---------|---------------|
| tests red | `report.json` → `results[].error`; the ARIA snapshot |
| hallucinated locators | the `grounding` score; the `identifyElements` node trace |
| no trace | telemetry bootstrap / `LANGFUSE_*` (Spike S5) |
