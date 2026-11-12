# Writing an app's docs by walking it: `cairn collect-docs`

When a product has no user documentation, `cairn collect-docs` writes a first version by walking its UI: every
screen it reaches by the app's own links, and every dialog, drawer, menu and wizard on those screens. A person edits
the result; [`cairn check-docs`](./check-docs.md) compares docs like these with the UI.

```bash
cairn collect-docs --url https://app.example.com --session myapp
# the same:
cairn docs --url https://app.example.com --session myapp
```

| Flag | Meaning |
|---|---|
| `--url <url>` | The app's start page (required) |
| `--session <name>` · `--session-file <path>` | A saved login session, as for `explore` ([sessions](./sessions.md)) |
| `--max-pages <n>` | The most screens to walk (default 10). One LLM call per new or changed screen |
| `--out <dir>` | Where to write (default `runs/docs-<id>/`) |
| `--fresh` | Describe every screen again, even an unchanged one |
| `--api-origin <list>` | Origins besides `--url`'s whose API requests go into the OpenAPI draft |
| `--channel <c>` · `--headed` · `--routing <preset>` | As for `explore` |

## What the walk does

1. Opens `--url`. An address that cannot be reached, or a start page with no heading and no control, stops the run
   with a one-line error and writes nothing.
   A walk that fails part-way still writes `openapi.derived.json` from the API requests recorded so far (a partial draft, noted in the log); no `docs.md` is written then.
2. Follows the app's links, same origin only, never a sign-out or deletion link, up to `--max-pages` screens.
3. On each screen, opens what announces an overlay (`aria-haspopup`, `aria-expanded`, `aria-controls`) as `explore`
   does: in a throwaway browser that stops every request but GET, HEAD and OPTIONS, so documenting changes nothing on
   the server. It records what opened each overlay, its ways out, what completes it, the overlays it opens and the
   steps of a wizard. Save, Submit, Delete and buttons that submit a form are never pressed.
4. Reads the fields of each screen and overlay, and which are required (`required` or `aria-required="true"` in the
   DOM).
5. Asks the model once per screen what the screen and its overlays are for and what a user might come there to do,
   from the ARIA snapshot only. Anything unclear — a status, a code or a label shown without explanation — comes back
   as a question. Abbreviations that are not common knowledge (`SLA`, `MRR`) are asked about without asking the model.
6. Writes the docs, the screenshots and, from the app's API requests seen on the way, `openapi.derived.json`
   (as `explore` does, #229).

The description of a screen is cached in `.cairn-cache/understanding/screens/`, keyed by the URL and a fingerprint of
what the walk saw there (the ARIA snapshot and the overlays found) — the same cache `explore` keeps its page
understanding in ([ADR-0018](./adr/0018-documentarian-page-understanding-cache.md)). A second walk of an unchanged
screen makes no LLM call and writes the same text; a screen that changed is described again.

## What it writes

```
runs/docs-<id>/
├─ docs.md                  the docs
├─ screenshots/             01-home.png, 02-projects.png, 02-projects-overlay-1.png, …
└─ openapi.derived.json     when the app made API requests the draft could use
```

## The format of `docs.md`

The format is fixed, so a person can edit it and a tool can read it back. Everything is plain Markdown.

- `# Docs: <origin>`, then one paragraph.
- One section per screen and per overlay, in walk order (a screen, then the overlays found on it):
  `## <Kind>: <title>`, where the kind is `Screen`, `Dialog`, `Alert dialog`, `Drawer`, `Menu`, `List` or `Wizard`
  (a dialog with Next and Back or a step indicator). A screen's title is its first level-1 heading (else its first
  heading, else its path); an overlay's is its accessible name. An overlay met on several screens is one section.
- In each section, in this order:
  - the screenshot, `![<Kind>: <title>](screenshots/<file>.png)`;
  - screens: `- Address: ` with the path;
  - `- What it is: ` — the model's sentence, or `_Not described._`;
  - screens: `- Who gets here: ` — `the start address` and/or `Screen "<title>" — link "<name>"`, separated by `; `;
    overlays: `- Opened from: ` — `<Kind> "<title>" — button "<name>"`, separated by `; `;
  - overlays: `- Ways out: ` (Escape and a click outside only when they were seen to close it, the close and cancel
    buttons) and `- Completes with: ` (Save, Submit…; a destructive one is marked);
  - `**Fields**` — `- "<name>" — <role>`, with `, required` when the DOM says so;
  - wizards: `**Steps**` — one numbered line per step: its headings, its fields, and what blocked Next;
  - `**User can**` — one line per control: `Go to Screen "<title>" — link "<name>"`, `Open Dialog "<title>" — button
    "<name>"`, `Follow the link "<name>"`, `Press "<name>"`, `Switch to the tab "<name>"`, `Choose "<name>"`;
  - `**User might**` — the model's tasks.
  
  A list with nothing in it reads `_None._`.
- Last, `## Questions` — one line per question, `- <Kind> "<title>": <question>`. Answer them in the docs; the
  sections above never guess at them.

A short sample, from the fixture app in the tests:

```markdown
## Dialog: New project

![Dialog: New project](screenshots/02-projects-overlay-1.png)

- What it is: create a project
- Opened from: Screen "Projects" — button "New project"
- Ways out: Escape, button "Cancel", a click outside it
- Completes with: button "Save"

**Fields**

- "Project name" — textbox, required
- "Description" — textbox
```

## Limits

- Screens are what the app's links reach. A screen reached only by a button, a form or a typed address is not walked;
  tabs and other view switchers on a screen are not opened.
- Overlays are found as `explore` finds them (#225): only a button that announces one is pressed,
  and the cli backend presses nothing (it reads the overlays already open).
- Required fields are read from the DOM; a field marked required only by a `*` in its label is not.
- The fields of a wizard's later steps are listed by name; whether they are required is not read.
- Two different overlays with the same kind and title on different screens are one section.
- Abbreviation questions look at ASCII capitals only.
