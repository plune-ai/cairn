#!/usr/bin/env bash
#
# Scripted, non-interactive Cairn walkthrough for asciinema — NO secrets, NO network calls.
# It only exercises --version / --help surfaces, so it is safe to record and publish.
#
#   asciinema rec docs/demo/cairn.cast -c ./scripts/demo.sh
#
# By default it drives the locally built CLI (run `npm run build` first). Override with:
#   CAIRN="cairn" ./scripts/demo.sh     # use a globally installed cairn instead of the built dist
#   DEMO_PAUSE=2  ./scripts/demo.sh     # slower pacing for a nicer recording
set -euo pipefail

CAIRN="${CAIRN:-node dist/cli/index.js}"
PAUSE="${DEMO_PAUSE:-1}"

say() { printf '\n\033[36m# %s\033[0m\n' "$1"; sleep "$PAUSE"; }
run() { printf '\033[2m$ cairn %s\033[0m\n' "$*"; sleep "$PAUSE"; $CAIRN "$@" || true; sleep "$PAUSE"; }

if [ "$CAIRN" = "node dist/cli/index.js" ] && [ ! -f dist/cli/index.js ]; then
  echo "Build first:  npm run build   (or set CAIRN=cairn to use a global install)"
  exit 1
fi

say "Cairn — an AI that walks your system and leaves a trail of tests: UI, API, unit, docs."
say "Cairn = generation layer · Plune = record / management / eval layer."
run --version
run --help
say "Explore a page -> methodology-based test cases -> @playwright/test code (UI surface, today):"
run explore --help
say "Design-only (no code) and automate-from-cases are separate, decoupled subcommands:"
run design --help
say "A real run needs a captured session + an API key, e.g.:"
printf '\033[2m$ cairn explore --url https://app.example.com/page --session myapp\033[0m\n'
sleep "$PAUSE"
say "Future surfaces are gated, by demand:  cairn ui|e2e · cairn api · cairn unit · cairn docs"
