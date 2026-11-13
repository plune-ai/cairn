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

### Test cases from `inputSchema` (no call is sent)

`cairn mcp-test` also builds test cases from each tool's `inputSchema` and writes them to `mcp-cases.json` next to
`mcp-model.json` and `mcp-guard.json`. It uses no model and no network, and it sends no tool call: the cases are data for a
runner that comes later. The console summary (cases per tool by kind, what was cut, what was skipped) is printed when no call flag is given; when
calls are asked for, the file is still written but the summary is not printed.

Every case is checked against the tool's own schema with Ajv (JSON Schema 2020-12, with formats) before it is kept: a
Positive case must pass the schema and a Negative case must fail it, and for the reason its kind names (`missing-required` needs a `required` error for that
argument, `wrong-type` a `type` error on it, a `boundary` case an error for that keyword on it). A case that does not behave so is not written; it is
listed under `skipped` with the schema keyword that explains it (`pattern`, `not`, `minLength`, ...). A schema that
declares a `$schema` other than `https://json-schema.org/draft/2020-12/schema` (written with or without a trailing `#`) is
skipped as a whole, with `$schema` as the keyword.

Kinds, in the order they are kept when a tool has more cases than `--max-cases-per-tool` (default 12):

1. `valid`: the required arguments only. Values come from `const`, the first of `examples`, `default`, the first `enum`
   value, the first `oneOf`/`anyOf` branch, then the simplest value of the type.
2. `missing-required`: one case per required argument, left out.
3. `wrong-type`: one case per argument, set to the first value of another JSON type that the schema refuses with a `type` error.
4. `boundary`: for `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`,
   `maxItems`: a value on the limit and one just beyond it.
5. `branch`: one case per `oneOf`/`anyOf` branch, at the top of the schema and on each argument.
6. `enum`: one case per listed value (at most 32 per argument).
7. `all-params`: every declared argument at once.

Cases over the limit are not written; the summary and `cut` in the file give the count per tool and per kind. Ids and names
are fixed before the cut, so the limit does not change them. A name looks like `tool · kind · detail`; the `stableId` is
built from the tool, the kind and the detail (argument name, enum value, branch index), never from the argument values.

What the generator does with a schema from a foreign server:

- `$ref` is followed only when it is a local pointer (`#`, `#/$defs/...`, `#/definitions/...`). Any other reference is not
  loaded and the tool is skipped with `$ref`; so is a reference that leads back to itself.
- A schema deeper than 32 levels or with more than 5000 nodes is skipped with `limit`, wherever the nesting is (a
  property that is called `default` or `enum` is looked into like any other). A `oneOf`, `anyOf` or `allOf` with more than
  100 branches is skipped with that keyword. Strings are built up to 256
  characters and arrays up to 64 items; a limit that needs more is skipped with `minLength`, `maxLength`, `minItems`
  or `maxItems`.
- A `pattern` is never turned into a regular expression to make a value, so a schema with a `pattern` usually ends in
  `skipped`. Ajv does run the pattern to validate the generated value, and a regular expression cannot be interrupted
  where it runs. So every schema check of every tool (compile and every validation) runs in a worker thread, with one
  time limit of 2 seconds for the whole tool and one of 15 seconds for all tools together. When a tool passes its limit the
  worker is terminated and replaced, the tool gets no cases, and one `skipped` entry with the keyword `pattern` says the
  check took too long. When the 15 seconds are spent, the tools not yet checked are skipped with the keyword `budget`
  and the reason "time budget for checking schemas was spent"; the summary counts them. A schema larger than 256 KiB
  once written as JSON is skipped with `limit` before anything else looks at it. The cases are made after the server
  connection is closed, and a line on stderr ("checking N tool schemas…") says the work has begun.
- Two or more tools with the same exact name are all skipped (keyword `name`), whatever order the server sent them in.
- Ids: the `stableId` is a hash of the exact tool name, kind and detail (case and spaces kept), so it does not depend on
  the order of tools, properties or enum values, or on `--max-cases-per-tool`. A name shown to people is
  `tool · kind · detail`.
- Only the top-level properties of the arguments get `wrong-type`, `boundary`, `branch` and `enum` cases; nested objects
  are built whole.
- A tool with no properties gets no cases; the summary says so.

`--examples <file>` is a JSON object `{"tool_name": {"argument": value}}` (at most 1 MiB, strict JSON). The value is used as
the arguments of the `valid` case, and the other cases are built from it. A value the tool's schema refuses is an error
that names the tool (exit code 1). So is a tool name the server does not have, and a value for a tool that gets no cases
(for example one with no properties). `mcp-cases.json` is written first in every one of these errors, then the command
exits with code 1.

A case whose arguments hold a value that the secret masking would change (a value taken from `--env`, `--header` or the
`--url`) is not written masked; it is listed under `skipped` with the reason `value masked`.

The expected answer in a case: a Positive case expects a successful result; a Negative case accepts either a JSON-RPC
error or a result with `isError: true`, as each case lists (the cases written by `cairn mcp-test` list -32602 and `isError`).
The cases are run by the flags described under "Running the cases" below.

### Adversarial cases (`--adversarial`)

`--adversarial [styles]` adds cases that put awkward values into tool arguments. A bare flag means `normal,curious,psycho,
hacker`; an unknown name, an empty value or a name in capitals is named on stderr and ignored (it never widens the choice; names are
lower-case). If the schema check of a tool fails while its adversarial values are checked (it ran out of time), only that
tool's adversarial cases are skipped, counted under `skipped`; its ordinary cases stay. The two limits take plain decimal
whole numbers. Like the other cases they are
only written to `mcp-cases.json` (key `adversarial`); this command sends nothing, and the summary says so. The call guard
treats `psycho` and `hacker` as mutating styles, so each case records what the guard says now (`guard`): without
`--allow-mutations` they are "not sent: mutations disabled".

- `normal` and `curious` make no new cases. They tag the existing ones (`adversarialStyle`): `valid` is `normal`;
  all-params, enum and branch cases are `curious`.
- `psycho`: the largest safe integer and `-1` in the first numeric parameter; a long string, an empty string, a string
  with a zero byte and a string with an unpaired surrogate in the first string parameter; an array nested to the depth
  limit in the first array parameter; a property the schema forbids when `additionalProperties` is `false`; an own key
  `__proto__` in the first object parameter (or among the arguments).
- `hacker`: four harmless strings in the first string parameter: a piece of SQL (WSTG-INPV-05), a script tag
  (WSTG-INPV-01), a shell command substitution naming a command that does not exist (WSTG-INPV-12), and a path that
  goes up to a name that does not exist (WSTG-ATHZ-01). The ids were read from the guide's own pages (version 4.2).
  A tool with no string parameter gets none of these. The SQL-shaped string is harmless as a string, but a careless server
  could paste it into a statement that changes data and make its condition always true; that is why `hacker` is a
  mutating style, sent only through the guard with `--allow-mutations`, the tool named, and on a test account.

The first parameter of a kind is the first by name; a parameter that only has `oneOf`/`anyOf` takes the type of its first
branch. Every case is checked by the same worker as the others, and says whether its value passes the tool's schema
(`schemaVerdict`, and `type` Positive or Negative to match): a payload inside a valid string is a Positive by schema.
The expectation is about behaviour, not about rejection: a JSON-RPC error, a result with `isError: true` or an answer
that does no harm are all fine; the server dying, the connection closing, a hang or an HTTP 5xx would be a failure. Whether a
payload was handled safely is not decided by a rule: those cases say `humanOracle: true` and the summary counts them.

Limits: the long string is 100000 characters (`--adversarial-max-string`, at most 200000) and the nesting is 100
(`--adversarial-max-depth`, at most 100); both are written in the file and in the summary. At most 16 cases per tool and
200 per run; the rest are counted as cut. When `hacker` is on and the run reaches an HTTP server with headers, `noCredentials` records, once, the call
without credentials for the first tool in `--allow-tools` that has a valid case (no header is in it; it is left out if
masking would change its arguments). `--expect-auth` only sets `expectAuth`: a pass would then be a failure instead of a
finding. It is a description: this command does not send it.

Not done here: sending the cases and judging the answers (a runner has to exist first), and the advice section. The
function that finds signs of a stack, a file system path or SQL in an error text (`findAdvice`) exists and only advises;
nothing uses it yet.

### Running the cases (`--allow-tools`, `--allow-read-only-hints`, `--allow-mutations`)

**These calls run on the server you point at, with the tools you allow. They can change data. Use a test account on a
test server, never one with real data.** Without a flag nothing is called.

With any of the three flags the command also sends the generated cases, one call per case and only through the call guard
(a case the guard refuses is `not-sent`). Each case ends in one of five states:

| state | meaning |
| --- | --- |
| `passed` | the server answered as the case expects |
| `failed` | the server's own answer broke a rule written in the case (or its process exited during the call while it was answering before) |
| `not-sent` | the call guard refused it (a tool not allowed, a budget, a tool that changed since permission); only the guard's refusal is `not-sent` |
| `could-not-run` | no answer: timeout, closed connection, server gone, an interrupt during the call, a tool list that could not be re-read, or the run stopped or ran out of `--time-budget` before it |
| `needs-review` | answered, but a person has to judge (an `isError` on a made-up valid value, an error the case does not list, an answer over `--max-response-bytes`, a payload only a person can judge) |

Rules. A valid case passes on a success (and, when the tool declares an `outputSchema`, a `structuredContent` that fits it;
the schema is compiled once per tool, and a tool whose check timed out is `needs-review` for the rest of the run). A JSON-RPC
error on a valid case fails. A case that breaks the schema passes only on what its `expect` lists: a JSON-RPC error with one of
the listed codes (-32602), or an `isError` result. Any other error code (-32603, -32601, -32700, ...) is `needs-review` with
the code named: the server refused, but not for the stated reason. It fails when the server accepts the value. A robustness
case (adversarial) follows its own `accepts` list literally. Observations (empty content, text only, time, size,
stack-trace-like text) are listed in `mcp-evidence.json` and never change a state or the exit code. The JSON-RPC code a server
answered is kept in the evidence (`rpcCode`); adversarial cases answered with -32603 (internal error) are counted in the summary
and `report.json` (`advice.internalErrorsOnHostileInput`) as advice only.

How a lost connection is told from a server's answer: only a fact on this side counts. "Timeout" is this side's own timer
firing; "the connection is gone" is the transport reporting that it closed (for stdio the child's exit). The code or text of
an error the server sent never counts: a live server that answers -32000, -32001 or the text "Connection closed" gave an
ordinary error answer, judged by the case's rule. A stdio server that exits fails that case; the run starts it once more and a
second loss stops the run (the rest is `could-not-run`). One restart budget covers every cause of a lost child: an exit, or the child being stopped for an oversized message. An interrupt (the run's signal) during a call is `could-not-run` and stops the run; it is never read as a server answer. Every result after the restart carries `afterRestart: true`, because
the server lost the state the earlier cases made.

Before every call the tool is read again (`tools/list`); a tool that changed since you looked (its schema, its description or
its `readOnlyHint`) is refused as "changed since permission", and when the list cannot be read or is cut short the call is not
sent: that case is `could-not-run` (never `not-sent`), and a connection found dead by the re-read is the lost process above (one restart, then stop). The read is skipped once a budget is spent. Each read takes a rate slot (`--rps`) but no call of `--max-calls`.

Size. `--max-response-bytes` (default 262144; a plain decimal whole number from 1 to 67108864) limits one answer, counted in
bytes. Over HTTP every response body is read through a counter and reading stops once its limit is passed: the call's limit
for a call, and 8 MiB for `initialize`, one `tools/list` page or a notification stream. A call whose body is cut for size ends at once. Over stdio the child's
output is counted per message: the reader refuses to buffer more than the larger of the limit and 1 MiB, and the child is
stopped when one message passes that cap (the run starts it again, as after an exit). What remains unbounded: a message
between the limit and the cap (up to 1 MiB) is parsed before it is judged, and a `tools/list` page above the cap ends the
connection (a re-read that fails that way is the lost process above). The stdio counter reads a private field of the SDK
transport; with an SDK version that lacks it the run prints "the stdio size counter is unavailable with this SDK version: only
the transport's own limit applies", `report.json` has `stdioSizeCounter: "unavailable"`, and the child keeps writing until the
transport's own refusal closes it. An answer over the limit is `needs-review` and is not stored; what is stored is masked first and cut after.

`--min-coverage <percent>` and `--count-partial` gate the share of tools that were covered (a tool is covered when every
declared parameter was sent by a case that was sent and judged; a tool with no such case is listed as not measured).

Exit codes: `0` at least one case passed and every other case that was sent passed too (cases the guard refused do not change
the code; the summary states the counts); `1` a case failed or the run stopped early; `3` coverage below `--min-coverage`; `4` a
guard budget ran out; `5` not proven: no case passed, or a case could not run or needs a person, or the server has no tools.
The order is 1, 3, 4, 5; when `--time-budget` ran out and a case also failed, the code is 1 and the budget is named in the
output. The call without credentials (HTTP, with `--adversarial` hacker) is not sent once the run was stopped or a budget ran
out. Artifacts in `runs/mcp-<id>/`: `report.json` (`mode: "mcp"`), `report.md`, `mcp-model.json`, `mcp-cases.json`,
`mcp-evidence.json`, `mcp-calls.jsonl`, `testcases/` (one ATC document per case). The cost is zero and no model is used.
