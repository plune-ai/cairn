# MCP server — Cairn as a tool for Claude Code / Cursor

Cairn exposes its core as an [MCP](https://modelcontextprotocol.io) server, so other agents (Claude
Code, Cursor, …) can call **“generate / maintain tests for this target”** as a tool. It is a thin
wrapper over the same core the CLI uses — no separate generation logic.

## Run

```bash
cairn mcp
```

This starts an MCP server over **stdio** (the transport MCP clients launch as a child process). The
`@modelcontextprotocol/server` package is an **optional dependency** (like Ink for the TUI) — install it
once if you haven't:

```bash
npm i @modelcontextprotocol/server
```

Without it `cairn mcp` says so on stderr, prints nothing on stdout and exits with code 1; every other command works.

### Protocol revisions

The server speaks both eras of the protocol, and the first message a client sends picks the era for the whole
connection:

| Client opens with | Revision served |
|-------------------|-----------------|
| `initialize` | the client's revision (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07), or 2025-11-25 when it asks for one the server does not know |
| `server/discover`, or any request with the 2026-07-28 `_meta` (no handshake) | 2026-07-28 |

The tools, their input and output schemas and their hints are the same in both. Their schemas use the JSON Schema
2020-12 dialect (`$schema`), also for clients of the older revisions. Stdout carries protocol only, one message per
line; anything else goes to stderr. The server exits when the client closes stdin.

## Tools

| Tool | What it does | Returns | Hints |
|------|--------------|---------|-------|
| `explore`  | Explore a page → methodology-based cases → `@playwright/test` code → validate ⇄ repair | cases, validation summary, metrics, Pilot verdict, cost, run dir | not read-only, not destructive, not idempotent, open world |
| `design`   | Explore a page → cases in ATC/MTC format, **no code** | cases, metrics, cost, run dir | not read-only, not destructive, not idempotent, open world |
| `automate` | Generate `@playwright/test` code from a previous run's ready ATC cases (the second half of design → automate) | spec files, validation, cost, run dir; with an active decider, `decider` and, when any, `notRepaired` and `healed` | not read-only, **destructive**, not idempotent, open world |

The hints are the tool `annotations` a client may show when it asks you to confirm a call. They describe what the
code does and are hints to the client, not a guarantee:
- every call is paid (model calls) and writes files, and every tool reaches the outside world (models, the target
  site);
- `explore` and `design` write a new `runs/<id>/` folder per call; `explore` with `intoProject` adds spec files to the
  project's testDir and renames its own file rather than overwrite one that exists;
- `automate` writes into the run it is given and replaces that run's `tests/` folder (with `intoProject` it adds the
  specs to the project's testDir and removes the run's `tests/`); `validate` runs the new tests against the target
  site.

Each result comes back twice: as JSON text, and as `structuredContent` matching the tool's `outputSchema`.

`explore` and `design` take the same input: `url` (required) plus optional `session`, `flow`, `setup`,
`gaps`, `critique`, `fresh`, `checklist`, `style`, `routing`, `backend`, `channel`, `maxPages`, `decider` —
mirroring the matching `cairn explore` flags. `automate` instead takes `run` (the run id/dir returned
by `design` or `explore`) plus optional `validate` / `session` / `routing` / `channel` / `decider`. Results come
back as JSON (run id, the generated cases or spec files, validation / metrics / Pilot, cost, and the
`runs/<id>/` directory).

Three parameters take a closed set of values, listed as an `enum` in the input schema; any other value is a
validation error and the call does no work:

| Parameter | Values | Same list as |
|-----------|--------|--------------|
| `decider` | `off`, `jev`, `laya`, `compat` (lower case) | `--decider` / `DECIDER` |
| `routing` | `volume`, `volume-fast`, `fast` | `LLM_ROUTING` presets |
| `backend` (`explore`, `design`) | `lib`, `cli` | `BROWSER_BACKEND` |

`channel` (`chrome`, `msedge`, …) and `style` (a style name or a pack path) stay free strings.

`decider` (`off` | `jev` | `laya` | `compat`) switches the [decision layer](decider.md) for one call, like
`--decider`. Everything else comes from the MCP server's own environment, as it does for the CLI:
- the provider's address and key ([Providers](decider.md#providers): `laya` reads `DECIDER_BASE_URL` and
  `LAYA_API_KEY`, `jev` the `TYPESAFE_*` pair);
- `DECIDER_USES`, `DECIDER_SHADOW` and the limits.

On `design` the parameter changes nothing unless the call passes a `checklist` and `coverage` is enabled; a
configuration error still fails the call at start. `coverage` is enabled when `DECIDER_USES` names it, or in shadow
mode with `DECIDER_USES` unset or empty, which asks every use point.
The default use point, repair triage, lives in the repair loop, which `design` does not run.

An active decider is reported by `explore` and `design` in the run's `report.json`. `automate` writes no report,
so it returns `decider`, `notRepaired` and `healed` instead. In shadow mode none of these keys appear: the answers go to
`runs/<id>/decider-shadow.json` (`decider-shadow-automate.json` for `automate`). A `decider: "off"` call is an
error while the server's environment sets `DECIDER_SHADOW=1`, just as `--decider off` is on the command line.

A typical agent flow: `design` a page → review the cases → `automate` the run dir it returned.

## Connect

Cairn reads the same environment as the CLI (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`,
`LLM_PROFILE`, …) — set them in the MCP client's environment. Config, role routing, and cost reporting
are reused from core unchanged.

### Claude Code

```bash
claude mcp add cairn -- cairn mcp
```

…or commit a project `.mcp.json`:

```json
{
  "mcpServers": {
    "cairn": {
      "command": "cairn",
      "args": ["mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-…" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "cairn": {
      "command": "cairn",
      "args": ["mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-…" }
    }
  }
}
```

If `cairn` isn't on `PATH`, run it through `npx`:
`{ "command": "npx", "args": ["-y", "@plune-ai/cairn", "mcp"] }`.

## Notes

- Runs are written to `runs/<id>/` exactly like the CLI; the tool result includes `runDir`.
- Authenticated targets need a saved session — capture one with `cairn session capture` first, then
  pass `session: "<name>"`. See [Authenticated targets](sessions.md).
- The server is a thin adapter: each tool validates input, calls the same `runExploration` /
  `runDesign` core entry points the CLI uses, and returns a structured result. No new generation logic.

## Reading someone else's MCP server: `cairn mcp-test`

The other direction. `cairn mcp` serves Cairn; `cairn mcp-test` connects to a server you name and writes a model of it.
It only connects and lists: no tool is called and no case is generated.

```bash
cairn mcp-test -- node ./my-server.js            # stdio: the command after `--`
cairn mcp-test --env API_KEY=... --cwd ./srv -- node server.js
cairn mcp-test --url http://127.0.0.1:3000/mcp --header "Authorization: Bearer ..."   # Streamable HTTP
```

Options: `--timeout <seconds>` for one request (default 30), `--out <dir>` (default `runs/mcp-<id>/`), and
`--max-pages` / `--max-entries` to bound each list (defaults 20 pages, 1000 entries).

`mcp-model.json` holds the server's `serverInfo`, the protocol revision it agreed to, its `capabilities` and its `tools`
(name, title, description, `inputSchema`, `outputSchema`, `annotations`), `resources`, `resourceTemplates` and `prompts`.
Lists are in name order and keys are sorted, so two reads of the same server give the same bytes. A list that was cut by a
limit is never passed off as whole: the model says `complete: false` and `truncated` names the list and the reason.

- Header and environment values are never stored; the model keeps their names only. What is masked, in the console,
  the error messages, the model (string values only; keys, numbers and booleans are never touched) and the saved
  `server-stderr.log`: a value whose name is sensitive (`Authorization`, `*key*`, `*token*`, `*secret*`, `*password*`,
  cookies) from 4 characters, with the credential part of `Bearer x`, a Basic pair and cookie values; a value under any
  other name from 8 characters; also their URL-encoded forms. Common values (`true`, `application/json`, ...) are never
  masked. Consequences: a value shorter than 8 characters under a neutral name is not masked, and a long ordinary word
  passed as a value is replaced wherever the server repeats it, so the model of the same server can differ between
  runs with different `--env`. Lists are put in order by their own names before masking, so the order does not depend
  on `--env`. Not covered: other encodings of a secret (base64, HTML), a secret that is part of the address path (only
  the user, password and sensitive query values of `--url` are masked), and the command arguments after `--`: pass
  secrets with `--env`.
- The server process gets the SDK's small default environment plus your `--env` values, not Cairn's provider keys.
  It is stopped whatever way the run ends (success, error, timeout, Ctrl-C).
- A request goes to the origin you named only. If the server answers 401 and points to authentication metadata on another
  origin, that address is not visited, no token is sent there, and the run stops with "authentication required".
  A redirect answer (3xx) is an error and is not followed. OAuth flows are not supported; pass a token with `--header`.
- Exit codes: `0` read; `1` the server did not start, did not answer `initialize`, wants authentication or spoke
  something else; `5` it was read but has no tools (nothing to test, not a pass).
- What a server writes (names, descriptions) is untrusted text: it is printed with control characters removed and is
  never run or handed to a model as an instruction. A line that would start with `::` or `##[` is prefixed, so a CI log
  does not read it as a workflow command. Values nested deeper than 64 levels (in a schema, annotations, prompt arguments
  or `capabilities`) are replaced by a mark and the model is marked `complete: false`.
- An interrupt (Ctrl-C) while the lists are read exits with `1` and keeps the model read so far, marked `complete: false`.
- Needs the MCP client package (`npm i @modelcontextprotocol/sdk`); without it the command says so.
- Limits. The server is asked to stop (stdin closed), then killed. On Windows its process tree is killed if it is still
  running then; on Linux and macOS only the direct child is, so a grandchild the server started (a shell wrapper, `npx`)
  can outlive the run. The size of an HTTP response is not
  limited. The time is bounded per request (`--timeout`, 30 s by default) and a list by `--max-pages` (20), so one list
  can take up to 20 pages times 30 s, and the four lists add up.

### The call guard: nothing is called unless you say so

A tool call is an action in someone else's system: the tool may delete a file, send a letter or spend money. The guard
decides before every call, and by default no call is sent. Every read of the server prints the tools in a table (tool,
class, proposed for permission), lists the tools whose hint and name disagree, and writes `mcp-guard.json`.

- `--allow-tools a,b,c`: the exact names that may be called. Names are compared byte for byte (case and spaces count);
  there is no "all", no empty name, no pattern: such a value is a usage error, not a permission. A name the server does not
  have is an error (exit `1`).
- `--allow-read-only-hints`: also allow the tools that the server claims read-only, **when the name passes a fixed
  rule** (below). The flag is trust in the server's claim, and the report says a permission rests on it. A claim is not a
  check: a tool called `get_` or `query_` can still write (one that runs SQL, for example).
- `--allow-mutations`: needed, together with the tool's name in `--allow-tools`, for any tool that is not claimed
  read-only with a clean name, or that reads as a deletion. Alone it allows nothing. It prints (and saves in the report) a
  banner: calls may change data, use a test account or a stand.
- Limits: `--max-calls` (default 100, retries included), `--rps` (default 2), `--call-timeout`, `--time-budget`. When a
  budget runs out the rest are not sent and are not counted as passed (exit code `4`). `--call-timeout` and
  `--time-budget` are accepted and checked, but nothing uses them until calls are sent; the other limits are enforced by the
  guard, which the call runner will ask.

What the trust flag requires. A tool is allowed on the server's claim only when all of these hold: `readOnlyHint` is `true`;
`destructiveHint` is not `true`; the name is plain ASCII letters, digits, `_`, `-` and `.`; the first word of the name
(after splitting `getReport`, `get_report`, `get-report` into words) is a read verb (`get`, `list`, `read`, `search`,
`find`, `describe`, `show`, `view`, `fetch`, `query`, `count`, `check`, `lookup`, `status`); and the crawler's deletion
words (English, Ukrainian, Russian) find nothing in the name or the title. Any other tool, whatever it claims
(`send_email`, `deploy`, `deletefile`, a name with a look-alike letter), needs its exact name in `--allow-tools`, and
`--allow-mutations` too when it is not claimed read-only with a clean name. The description is free text and takes no part
in the decision.

Classes: `read-claimed` (passes the rule above, and the only class that is proposed), `unknown` (no hint, or a read-only
claim that the name rule does not trust; the table says why) and `mutating` (hint `false`, `destructiveHint: true`, or a name
that reads as a deletion). Names from the server are untrusted text: a name with control or invisible characters, or two
tools whose names are the same after case folding and normalization, are refused even when named. A tool the server
changes after you saw it (a different description, schema or hint) is refused from then on, once the changed list has been
passed to the guard (the command does not do that yet: it waits for the call runner).

In this version the command only reads the server: asking for calls (`--allow-*`) ends with exit code `5`, because nothing
was sent and nothing was tested. The guard and the single function that may send a call (`src/mcp-test/call.ts`) are in
place for the runner that comes next; `mcp-calls.jsonl` will list only the calls that really went to the server (time,
tool, reason, masked arguments, duration, result).
