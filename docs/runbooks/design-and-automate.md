# Runbook: the decoupled `design` → `automate` flow

First we write test cases (a human-valuable artifact in the ATC/MTC format), and automate separately and optionally.

## 1. Preparation
- Session: `npm run session:save -- --url https://app.example.com/ --name myapp` (log in via Chrome, press Enter).
- (Opt.) Checklist: a `.md`/text file with items or `## TC-XX` headers — steers what to test.
- (Opt.) Domain knowledge: `./knowledge/<name>.md` with `url: /path` frontmatter (credentials, validation rules) → injected into the design.

## 2. `design` — test cases only (no code)
```
cairn design --url https://app.example.com/page --session myapp --checklist plan.md
```
Writes `runs/<id>/testcases/*.md`:
- **ATC-<SUITE>-NNN.md** — `execution: auto` (read-only, verified locators) → can be automated; `status: ❌ Not implemented`.
- **MTC-<SUITE>-NNN.md** — `execution: manual` (full generation/submit, security/XSS, UI-UX/visual, irreversible actions) → NOT automated; `status: 📋 Manual`.

Each case: frontmatter (id/suite/priority P1-3/type/execution/status/automation) + Preconditions + Steps + Expected + **Selectors** (recorded `getByRole` locators) + Traceability. Language = the language of the checklist/page.
Metrics: grounding, verified_ratio, test_case_quality, methodology_adherence, **checklist_coverage** (semantic, cross-language), Pilot verdict.

**A human reviews/edits the cases** (it's their artifact).

## 3. `automate` — code from approved cases
```
cairn automate --run runs/<id> [--validate --session myapp]
```
- Reads `testcases/*.md`, **skips MTC/manual**, generates `@playwright/test` from the ATC cases (locators are taken from the Selectors section) → `runs/<id>/tests/`.
- `--validate` — runs the generated tests (a session is required).

## 4. Alternative — `explore` (everything at once)
```
cairn explore --url ... --session ... [--checklist ...]
```
observe→design→code→validation→repair (keep-best)→Pilot verdict — a validated suite + metrics right away.

## 5. Plug into an existing Playwright project (`--into-project`, #51)
```
cairn explore  --url ... --into-project           # detect playwright.config.* from cwd
cairn automate --run runs/<id> --into-project ./e2e   # or point at a project dir
```
- Detects the nearest `playwright.config.{ts,js,mjs,cjs}` (walking up from the cwd, or from the given `dir`), resolves its `testDir`, and writes the specs **there** using the project's filename convention (`.spec.ts` vs `.test.ts`, read from `testMatch`). Run them with the project's own `npx playwright test`.
- **Collision-safe:** a pre-existing spec is never overwritten — Cairn writes a disambiguated file beside it (e.g. `login.cairn.spec.ts`).
- Validation/repair run against an isolated `runs/<id>/tests` sandbox (same Playwright, identical result — your existing suite is never run or deleted); the validated best specs are then placed in the project's `testDir`, and the `runs/<id>/` trail keeps study/report/testcases.
- Without the flag, nothing changes (greenfield `runs/<id>/tests/`). If no config is found, Cairn says so and falls back to greenfield.
