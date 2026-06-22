# Prompt overrides

Drop a `<name>.md` file in this folder to override a built-in Cairn prompt **without rebuilding**.
This folder ships committed so you can see exactly what is overridable and edit it in place.

## Precedence (highest first)

1. **Langfuse** — when `LANGFUSE_*` is configured and the prompt exists there (versioned, labelled).
2. **`prompts/<name>.md`** — this folder. What you edit locally wins over the built-in default.
3. **Built-in constant** — `src/prompts/local/<name>.ts`, the offline default that always works.

`{{var}}` placeholders are interpolated at run time; a missing variable becomes empty.

## Methodology vs house-style — important

`qa-testcase-from-ui.md` here is the built-in design prompt **verbatim**, so you can see what you
may tune. ⚠ It becomes the live prompt the moment you change it. Keep the **METHODOLOGY**,
**ASSERTION SAFETY**, and **STABILITY** sections intact — those are what make the generated cases
correct, safe, and runnable.

If you only want to change **naming / format / language / tone** (not which techniques are covered
or how assertions are written), do **not** edit the methodology — use a **style pack** instead:

```bash
cairn design --url <u> --session <s> --style concise
```

`--style <value>` resolves in order:

1. a **style pack** — `prompts/styles/<value>.md` (built-in or yours), or an explicit `.md` path —
   whose text is loaded into the prompt's `{{style}}` slot;
2. otherwise a built-in **inline hint** — `happy` / `negative` / `coverage` (focus directives),
   or `all` / anything else → balanced (no directive).

Built-in packs live in [`styles/`](styles/): `concise`, `gherkin`, `detailed-manual`.

## Prompt names

`qa-testcase-from-ui` · `qa-manual-test-designer` · `qa-case-critique` · `qa-playwright-ts-writer` ·
`identify-elements` · `judge-test-cases` · `judge-checklist-coverage` · `pilot-review`
