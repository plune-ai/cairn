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
