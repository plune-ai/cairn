# Do the docs still match the UI? `cairn check-docs`

`cairn check-docs` walks the app the way [`cairn collect-docs`](./collect-docs.md) does and compares what it sees with
docs in the same format: a `docs.md` that `collect-docs` wrote and a person has edited since. It is meant for CI: exit
0 when the docs match, 2 when something differs.

```bash
cairn check-docs --docs runs/docs-<id>/ --url https://app.example.com --session myapp
cairn check-docs --docs docs/app/docs.md --url https://staging.example.com --spec openapi.yaml
```

| Flag | Meaning |
|---|---|
| `--docs <path>` | The docs: a `docs.md` in the collect-docs format, or a directory holding one (required) |
| `--url <url>` | The app's start page (required) |
| `--spec <path>` | An OpenAPI 3.x spec (JSON or YAML) to compare with the API requests the app made while walked |
| `--session <name>` · `--session-file <path>` | A saved login session ([sessions](./sessions.md)) |
| `--max-pages <n>` | The most screens to walk (default 10) |
| `--out <dir>` | Where to write the report (default `runs/check-docs-<id>/`) |
| `--api-origin <list>` · `--channel <c>` · `--headed` | As for `collect-docs` |

It makes no LLM call and needs no API key: only facts are compared.

## What is compared

The walk's result is written in the docs format and read back with the same reader as the docs, so both sides are
read alike. For each section:

- **Screens** are paired by their `Address`, **overlays** by kind and title. A section left alone on each side with the
  same address (a screen) or the same "Opened from" (an overlay) is the same section, renamed.
- **Fields** (`**Fields**`) by role and name; **controls** (`**User can**`) by role and name, and where a link or a
  trigger leads. A field or control left alone on each side with the same role is the same one, renamed. A renamed
  section does not make every link to it differ: links are compared through the pairing.
- Not compared: "What it is", "User might", the steps of a wizard, the ways out of an overlay, whether a field is
  required, the Questions, and lines of "User can" in a form collect-docs does not write (free text stays the
  writer's).

Three kinds of mismatch:

| Kind | Example |
|---|---|
| In the docs, not in the UI | `Screen "Projects": button "Archive"` |
| In the UI, not in the docs | `Screen "Settings": field "Email alerts" (checkbox)` |
| Name differs | `Dialog "New project": the name of a textbox field: "Name" in the docs, "Project name" in the UI` |

With `--spec`, the API operations the app called while it was walked (`openapi.derived.json`, as `explore` writes it)
are compared with the spec's, parameter names left out (`/projects/{id}` is `/projects/{projectId}`). An operation the
app called that the spec lacks is a mismatch. One the spec has that the walk did not see is listed, but is no mismatch:
the walk only sees what the screens it reached called.

## What it writes

```
runs/check-docs-<id>/
├─ check-docs.md            the report
├─ screenshots/             the screens and overlays as the walk saw them
└─ openapi.derived.json     the API operations the app called
```

`check-docs.md` starts with the verdict — **The docs match the UI.** or **N mismatch(es) between the docs and the
UI.** — then one section per kind of mismatch (`_None._` when empty), each line linking to the section of the docs
and to the screenshot of the screen; then, with `--spec`, the API lists.

Exit codes: 0 the docs match; 2 a mismatch; 1 the docs could not be read (no sections in the collect-docs format) or
the app could not be walked.

## Limits

- The docs must be in the collect-docs format; other Markdown, and docs at an address, are not read.
- The walk reaches what `collect-docs` reaches (links, overlays that announce themselves; see its
  [limits](./collect-docs.md#limits)): a screen the docs describe but the walk does not reach is reported as not in
  the UI. Raise `--max-pages` when the app has more screens.
- A control or field removed and another of the same role added in the same section reads as one renamed.
