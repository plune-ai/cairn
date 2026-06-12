# Cairn demo (asciinema)

A scripted, non-interactive walkthrough of the `cairn` CLI — **no secrets, no network calls** (it only
drives `--version` / `--help`). Safe to record and publish.

## Record

```bash
npm run build                                       # the demo drives the built CLI
asciinema rec docs/demo/cairn.cast -c ./scripts/demo.sh
```

Tune pacing with `DEMO_PAUSE` (seconds) and target a global install with `CAIRN`:

```bash
DEMO_PAUSE=2 CAIRN=cairn asciinema rec docs/demo/cairn.cast -c ./scripts/demo.sh
```

## Play back

```bash
asciinema play docs/demo/cairn.cast
```

## Publish + embed

Upload to get a cast id, then point the README hero badge at it:

```bash
asciinema upload docs/demo/cairn.cast
```

```md
[![Cairn demo](https://asciinema.org/a/<id>.svg)](https://asciinema.org/a/<id>)
```

> The cast file (`cairn.cast`) is intentionally **not committed yet** — record it right before launch so it
> reflects the shipped CLI. Until then the README hero carries a placeholder marker
> (`<!-- asciinema: docs/demo/cairn.cast (record before launch) -->`) and a `REPLACE_ME` badge.
