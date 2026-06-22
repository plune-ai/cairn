# Prompts & styles

Cairn separates **what makes a test case correct** (the methodology — fixed) from **how it reads**
(the house style — yours to change). This page explains both knobs.

## Override precedence

Each prompt is resolved in this order (highest first):

1. **Langfuse** — when `LANGFUSE_*` is configured and the prompt exists there (versioned, labelled).
2. **`prompts/<name>.md`** — a committed/local override file. What you edit here wins over the default.
3. **Built-in constant** — `src/prompts/local/<name>.ts`, the offline default that always works.

`{{var}}` placeholders are interpolated at run time; a missing variable becomes empty. The committed
[`prompts/`](../prompts/README.md) folder ships an example — `prompts/qa-testcase-from-ui.md` is the
built-in design prompt **verbatim**, so you can see exactly what is overridable.

Prompt names: `qa-testcase-from-ui` · `qa-manual-test-designer` · `qa-case-critique` ·
`qa-playwright-ts-writer` · `identify-elements` · `judge-test-cases` · `judge-checklist-coverage` ·
`pilot-review`.

## Methodology vs house-style — what `--style` may change

The design prompt has a fixed **METHODOLOGY**, **ASSERTION SAFETY**, and **STABILITY** section (ported
from `AZANIR/qa-skills`, [ADR-0008](adr/0008-methodology-port-from-qa-skills.md)). These decide **which**
29119-4 techniques apply and **how** assertions are written — they are not a styling knob and should
stay intact when you edit a prompt.

A **style** only fills the prompt's `{{style}}` slot — it affects **naming, format, language, and
tone**, never technique coverage or assertion safety.

## `--style <value>` — dual behavior

```bash
cairn design --url <u> --session <s> --style concise
```

`--style` resolves in order:

1. a **style pack** — [`prompts/styles/<value>.md`](../prompts/styles/) (a built-in or your own pack),
   or an explicit `.md` path — whose text is loaded into the `{{style}}` slot;
2. otherwise a built-in **inline hint** — `happy` / `negative` / `coverage` (focus directives), or
   `all` / anything unrecognized → balanced (no directive).

### Built-in packs

| pack | effect (format only) |
|---|---|
| [`concise`](../prompts/styles/concise.md) | short specific titles, terse one-action steps, single checkable expected |
| [`gherkin`](../prompts/styles/gherkin.md) | steps in Given / When / Then form, one When per case |
| [`detailed-manual`](../prompts/styles/detailed-manual.md) | exhaustive preconditions, numbered fully-spelled-out steps, for a human tester |

### Your own pack

Drop a Markdown file in `prompts/styles/` (or anywhere and pass the path) and select it by name:

```bash
echo "STYLE FOR THIS RUN: titles in Ukrainian, steps numbered." > prompts/styles/my-house.md
cairn design --url <u> --session <s> --style my-house
```

Keep a pack about *format/tone* only — the methodology stays fixed regardless of the style.
