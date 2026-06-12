#!/usr/bin/env bash
#
# Generate docs/demo/cairn.cast (asciicast v2) from scripts/demo.sh — no asciinema / PTY needed.
# The result plays in `asciinema play docs/demo/cairn.cast` and any asciinema-player. Re-run whenever
# the CLI surface changes. Requires: node (built dist) + jq.
#
#   ./scripts/gen-cast.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
[ -f dist/cli/index.js ] || npm run build

raw="$(mktemp)"
DEMO_PAUSE=0 bash scripts/demo.sh > "$raw" 2>&1
ts=$(date +%s)

# Header line + one [t,"o",data] event per output line, 0.4s apart, each terminated with CRLF.
jq -cRn --argjson ts "$ts" '
  {version:2, width:100, height:32, title:"Cairn — CLI walkthrough", timestamp:$ts,
   env:{TERM:"xterm-256color", SHELL:"/bin/bash"}},
  foreach inputs as $line (0; . + 4; [(. / 10), "o", ($line + "\r\n")])
' "$raw" > docs/demo/cairn.cast

rm -f "$raw"
echo "wrote docs/demo/cairn.cast ($(jq -s 'length' docs/demo/cairn.cast) lines)"
