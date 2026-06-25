# Cairn — CI / PR bot (GitHub Action)

Run [Cairn](https://github.com/plune-ai/cairn) on a pull request: it generates/updates Playwright UI
tests for the changed surface, posts a **summary comment**, and can **optionally open a follow-up PR**
carrying the tests (#50, `v1 = generation-on-PR`). Maintenance / self-heal is a later epic (#46) and is
out of scope here.

The action is a thin wrapper over the shared Cairn core (same entry points as `cairn explore` /
`cairn design`); generated specs land in your existing Playwright project via the `--into-project`
writer (#51) when a `playwright.config.*` is present.

## Usage

```yaml
# .github/workflows/cairn.yml
name: Cairn tests
on:
  pull_request:

permissions:
  contents: write        # only needed when open-pr: true (creates a branch + commit)
  pull-requests: write   # post the summary comment / open the follow-up PR

jobs:
  cairn:
    runs-on: ubuntu-latest
    env:
      # Provider keys come from repo secrets — NOT from action inputs (so they are never echoed).
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      # Optional, depending on your routing / observability:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
      LANGFUSE_BASE_URL: ${{ secrets.LANGFUSE_BASE_URL }}
      LANGFUSE_PUBLIC_KEY: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
      LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: plune-ai/cairn-action@v1      # see "Distribution" below
        with:
          url: https://staging.example.com/login
          mode: explore
          paths: |
            src/app/login/**
            src/components/auth/**
          comment: true
          open-pr: false
```

## Inputs

| Input            | Default                          | Description |
| ---------------- | -------------------------------- | ----------- |
| `url`            | — (**required**)                 | Page URL to generate tests for. |
| `mode`           | `explore`                        | `explore` (cases + code) or `design` (cases only). A follow-up PR needs `explore`. |
| `session`        | —                                | Saved session name for authenticated targets. |
| `checklist`      | —                                | Path to a checklist file that steers what to test. |
| `style`          | —                                | Planning style / house-style pack. |
| `routing`        | —                                | Role-routing preset: `fast` \| `volume` \| `volume-fast`. |
| `backend`        | `lib`                            | Browser backend: `lib` \| `cli`. |
| `channel`        | —                                | System browser channel (e.g. `chrome`). |
| `into-project`   | `true`                           | Write specs into the host Playwright `testDir` (else greenfield `runs/`). |
| `project-dir`    | —                                | Explicit project dir for `into-project`. |
| `paths`          | —                                | Newline/comma globs — run only when the PR changed a matching file (changed-surface gate). |
| `comment`        | `true`                           | Post/update the summary comment. |
| `open-pr`        | `false`                          | Open a follow-up PR with the generated tests. |
| `pr-branch`      | `cairn/update-tests`             | Branch prefix for the follow-up PR (PR number appended). |
| `commit-message` | `test: update generated …`       | Commit message for the follow-up PR. |
| `pr-title`       | (commit message)                 | Title for the follow-up PR. |
| `github-token`   | `${{ github.token }}`            | Token for commenting / opening the follow-up PR. |
| `cairn-version`  | `latest`                         | npm version/tag of `@plune-ai/cairn` to install. |
| `install-browsers` | `true`                         | Install Playwright Chromium before running. |

## Required secrets (set by a repo admin — the action does **not** set these)

- `ANTHROPIC_API_KEY` (and/or `OPENROUTER_API_KEY`, `GROQ_API_KEY`, per your `routing`).
- Optional Langfuse: `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`.

Add them under **Settings → Secrets and variables → Actions**, then map them to job/step `env:` as in
the example above. Cairn reads them from the environment; they are never passed as action inputs.

## Required permissions

Grant these in the calling workflow (or org/repo default `GITHUB_TOKEN` permissions):

- `pull-requests: write` — to post/update the summary comment and open the follow-up PR.
- `contents: write` — **only** when `open-pr: true` (the follow-up PR creates a branch + commit).

## Fork PRs

On the default `pull_request` trigger, PRs from forks receive a **read-only** token, so the action
**skips** commenting / opening a PR (it logs the reason and still exits cleanly). To comment on fork
PRs you can use `pull_request_target` — do so deliberately and review the
[security implications](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/).

## Behavior notes

- **Idempotent comment.** Re-running on the same PR **updates** the existing Cairn comment (matched by a
  hidden marker) instead of posting duplicates.
- **No changed surfaces.** When `paths` is set and the PR touched no matching file, the run is a no-op:
  it posts a short "no tests generated" comment and skips generation.
- **Follow-up PR is opt-in.** It only runs with `open-pr: true`, in `explore` mode, with a writable
  token, and when specs were actually generated.

## Distribution

`v1` ships the action **source in the Cairn repo** under [`action/`](.). Reference it either by sub-path:

```yaml
- uses: plune-ai/cairn/action@v1
```

or, once a maintainer mirrors `action/` to a dedicated `plune-ai/cairn-action` repo (a release step, not
done by this PR), by the short form `uses: plune-ai/cairn-action@v1`.
