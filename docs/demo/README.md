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

## Regenerate (no asciinema needed)

The committed `cairn.cast` is generated deterministically from `scripts/demo.sh` against the built CLI
(`jq`-built asciicast v2 — no live PTY). Re-run after any CLI-surface change:

```bash
./scripts/gen-cast.sh
```

## Publish + embed (optional — inline player in the README)

GitHub doesn't render `.cast` files inline, so the README hero links to the file. For an animated player
badge, upload to asciinema.org and swap the id into the README hero:

```bash
asciinema upload docs/demo/cairn.cast
```

```md
[![Cairn demo](https://asciinema.org/a/<id>.svg)](https://asciinema.org/a/<id>)
```

> `cairn.cast` **is committed** (generated from the demo script — see *Regenerate* above). For a live,
> human-paced recording instead, use the `asciinema rec` command at the top; it overwrites the same file.
