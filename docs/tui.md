# Interactive TUI (optional)

Run `cairn` with **no arguments** in a terminal to open the interactive TUI (built with Ink / React-for-CLI).
Ink and React are **optional dependencies** — a default install omits them to keep the footprint small.
Install them once to enable the TUI:

```bash
npm install ink react ink-select-input ink-spinner ink-text-input
```

Then:

```bash
cairn          # launches the terminal UI (requires the Ink packages above)
```

Pick a command (explore / design / automate), fill parameters (URL, session, checklist, style, fresh) via a
guided form, watch a **live dashboard** of the pipeline stages as the run progresses, read the result summary
(scores, green %, Pilot verdict, test cases), and **browse past runs** in `./runs` — opening any run to
read its test cases, report and logs.

The CLI commands stay available for scripting/CI; in a non-interactive (piped/CI) shell, `cairn` with
no arguments prints help instead of starting the UI. If the Ink packages are not installed, `cairn` with
no arguments also falls back to printing help.

See [ADR-0009](adr/0009-tui-ink.md) for the design rationale.
