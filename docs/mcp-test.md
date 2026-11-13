# Test an MCP server: `cairn mcp-test`

`cairn mcp-test` connects to an MCP server you name, reads what it offers, writes test cases from the tools' own
`inputSchema`, and, only when you allow it, calls the tools with those cases and judges the answers by fixed rules. It
uses no model and no network other than the connection to your server.

> **Two commands, two directions.** [`cairn mcp`](./mcp.md) is Cairn *as* a server: other agents call Cairn.
> `cairn mcp-test` (this page) is the other way round: Cairn is the client and tests *your* server.

This page goes in order: [read your server](#1-read-your-server), [look at the cases](#2-look-at-the-cases),
[run them on a test account](#3-run-the-cases), [read the result](#4-read-the-result). A shorter, step-by-step version is
the [runbook](./runbooks/test-an-mcp-server.md). The commands and outputs below are real: each was run from the source
tree of this repository (the `cairn` in a command stands for the CLI; here it was started with the source tree's own
TypeScript runner, no install and no build) against the test servers in this repository's `tests/fixtures/`. Where an
output is cut, the page says so; absolute paths are shown relative to the folder the command ran in, and the port of the
local HTTP test server is shown as `PORT`. `./notes-server.mjs` and `./my-server.mjs` below are copies of those test
servers. Replace them with your own server.

## Before the first call: read this

- **By default nothing is called.** Without `--allow-tools`, `--allow-read-only-hints` or `--allow-mutations` the command
  connects, lists, generates cases, prints them and writes files. The summary says "nothing was sent", and
  `mcp-guard.json` records `sent: 0`.
- **A call is an action in your system.** A tool may write a file, send a message, spend money or delete a record. The
  calls run on **your own server**, with the data that server holds. Run them against a **test account** on a test
  server, never against real data.
- **It undoes nothing.** There is no clean-up step. A case that creates a note leaves the note. A case that breaks the
  schema on purpose and is accepted by a careless server leaves whatever that server stored. The run lists every call in
  `mcp-calls.jsonl`, so you can find them afterwards; removing them is up to you.
- **`psycho` and `hacker` may change or destroy data.** These adversarial styles put extreme or hostile-looking values
  into arguments (see [styles](#adversarial-styles)). They are sent only with `--allow-mutations` **and** the tool's exact
  name in `--allow-tools`.
- **`--allow-read-only-hints` is trust in the server's own claim.** A tool that says `readOnlyHint: true` may still
  write; Cairn cannot check that. Use the flag only for a server you trust to describe itself honestly.
- **Secrets stay out of the files.** `--header` and `--env` values are never saved; answers and arguments written to disk
  are [masked](#masking) first.

## 1. Read your server

Stdio: put the server command after `--`.

```text
cairn mcp-test --out runs/r1 -- node ./notes-server.mjs
```

Output (the first line of any run, `injected env`, is a message of the configuration loader and is left out):

```text
MCP server: fixture-server 1.2.3 (protocol 2025-11-25)
  7 tool(s), 3 resource(s), 3 resource template(s), 3 prompt(s)
  Tools with an inputSchema that has properties: 6 (create_note, delete_note, move_note, search_notes, set_target, tag_note)
  Tools without properties: 1 (ping)
  Tools that declared readOnlyHint: 2 (ping, search_notes)
  Model: ./runs/r1/mcp-model.json
Tools the server offers (nothing is called without your permission):
  tool | class | proposed for permission
  create_note | mutating | no
  delete_note | mutating | no
  move_note | unknown | no
  ping | unknown | no (claims read-only; name does not start with a read verb)
  search_notes | read-claimed | yes
  set_target | unknown | no
  tag_note | unknown | no
  Proposed with --allow-read-only-hints or by name in --allow-tools: search_notes.
  Class read-claimed: This is the server's claim, not a check.
checking 7 tool schemas…
Cases from inputSchema: 32 (15 positive, 17 negative); nothing was sent.
  create_note: 7 (valid 1, missing-required 2, wrong-type 1, enum 3)
  delete_note: 3 (valid 1, missing-required 1, wrong-type 1)
  move_note: 5 (valid 1, missing-required 2, wrong-type 2)
  search_notes: 8 (valid 1, missing-required 1, wrong-type 2, boundary 4)
  set_target: 5 (valid 1, missing-required 1, wrong-type 1, branch 2)
  tag_note: 4 (valid 1, wrong-type 1, branch 2)
  ping: no cases (the input schema declares no properties).
  Skipped (1):
    create_note · wrong-type · kind: type — no value of another JSON type is refused by a type check for "kind"
  Cases: ./runs/r1/mcp-cases.json
exit 0
```

What happened: Cairn started the server, asked what it offers, and stopped it again. It wrote `mcp-model.json` (the
server's tools with their schemas and hints, resources, resource templates, prompts), `mcp-cases.json` and
`mcp-guard.json` into `runs/r1/` (without `--out` the folder is `runs/mcp-<id>/`). The table says how the call guard
classes each tool and which ones it would let through on the server's claim (`read-claimed`); nothing was called.

Streamable HTTP: give the address, and headers if the server wants them. This server requires a bearer token. Without
one the command stops:

```text
cairn mcp-test --out runs/h1 --url http://127.0.0.1:PORT/mcp
```

```text
✗ The server requires authentication (HTTP 401). OAuth is not supported here; pass a token with --header "Authorization: Bearer <token>".
exit 1
```

With the token it reads the server the same way (output cut: only the first lines are shown):

```text
cairn mcp-test --out runs/h2 --url http://127.0.0.1:PORT/mcp --header "Authorization: Bearer example-token-1234567"
```

```text
MCP server: fixture-server 1.2.3 (protocol 2025-11-25)
  7 tool(s), 3 resource(s), 3 resource template(s), 3 prompt(s)
  Tools with an inputSchema that has properties: 6 (create_note, delete_note, move_note, search_notes, set_target, tag_note)
  Tools without properties: 1 (ping)
  Tools that declared readOnlyHint: 2 (ping, search_notes)
  Model: ./runs/h2/mcp-model.json
```

Exit codes of the reading step: `0` it was read; `1` the server did not start, did not answer `initialize`, wants
authentication or spoke something else; `5` it was read but has no tools (nothing to test, which is not a pass).

## 2. Look at the cases

The same command already built cases from each tool's `inputSchema` (the "Cases from inputSchema" lines above): a valid
one, one per missing required argument, one per wrong type, boundaries, enum values, `oneOf`/`anyOf` branches. They are
data in `mcp-cases.json`; nothing was sent. Add `--adversarial` to also generate the awkward-value cases:

```text
cairn mcp-test --out runs/r2 --adversarial -- node ./notes-server.mjs
```

Output (cut: the part before `checking 7 tool schemas…` is the same as in step 1):

```text
checking 7 tool schemas…
  Adversarial: none was sent (no flag asked for calls). 56 cases are of the mutating styles (psycho, hacker): not sent: mutations disabled.
Cases from inputSchema: 32 (15 positive, 17 negative); nothing was sent.
  create_note: 7 (valid 1, missing-required 2, wrong-type 1, enum 3)
  delete_note: 3 (valid 1, missing-required 1, wrong-type 1)
  move_note: 5 (valid 1, missing-required 2, wrong-type 2)
  search_notes: 8 (valid 1, missing-required 1, wrong-type 2, boundary 4)
  set_target: 5 (valid 1, missing-required 1, wrong-type 1, branch 2)
  tag_note: 4 (valid 1, wrong-type 1, branch 2)
  ping: no cases (the input schema declares no properties).
Adversarial cases: 56 (psycho 32, hacker 24); string length 100000, depth 100.
  24 of them need a human-defined oracle: whether the payload was handled safely is not decided by a rule.
  Skipped (1):
    create_note · wrong-type · kind: type — no value of another JSON type is refused by a type check for "kind"
  Cases: ./runs/r2/mcp-cases.json
exit 0
```

`--max-cases-per-tool <n>` (default 12) bounds the cases per tool; the rest are counted as cut. `--examples <file>` is a JSON
object `{"tool_name": {"argument": value}}` (at most 1 MiB, strict JSON) that gives the arguments of a tool's valid case;
the other cases are built from it. A value the tool's schema refuses is an error that names the tool (exit `1`), and so is
a tool name the server does not have.

### Case kinds

In the order they are kept when a tool has more cases than the limit:

| kind | what it is | expected |
|---|---|---|
| `valid` | the required arguments only; values from `const`, the first `examples`, `default`, the first `enum` value, the first `oneOf`/`anyOf` branch, then the simplest value of the type | success |
| `missing-required` | one case per required argument, left out | refusal |
| `wrong-type` | one case per argument, set to a value of another JSON type that the schema refuses | refusal |
| `boundary` | for `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`: a value on the limit and one just beyond it | the one on the limit succeeds, the one beyond is refused |
| `branch` | one case per `oneOf`/`anyOf` branch | success |
| `enum` | one case per listed value (at most 32 per argument) | success |
| `all-params` | every declared argument at once | success |

Every case is checked against the tool's own schema (JSON Schema 2020-12, with formats) before it is kept: a case that is
meant to succeed must pass the schema, and one that is meant to be refused must fail it, for the reason its kind names. A
case that does not behave so is not written; it is listed under `skipped` with the schema keyword that explains it (see
the line `Skipped (1)` in the output above). Names look like `tool · kind · detail`; the `stableId` is a hash of the
tool, the kind and the detail (argument name, enum value, branch index), never of the values, so it does not change when
the order of tools or properties changes.

### What the generator can build from a schema

| In the schema | What Cairn does |
|---|---|
| `type`, `required`, `properties` | builds the valid case, one `missing-required` and one `wrong-type` case per argument |
| `enum`, `const` | one `enum` case per value; `const` is the value used |
| numeric and length bounds (`minimum`, `maxLength`, `minItems`, …) | `boundary` cases on and beyond each limit; a limit that needs a string over 256 characters or an array over 64 items is skipped with that keyword |
| `oneOf`, `anyOf` | one `branch` case per branch; more than 100 branches: the tool is skipped with that keyword |
| `$ref` to `#`, `#/$defs/…`, `#/definitions/…` | followed. A reference that leads back to itself is skipped |
| any other `$ref` | **not loaded**; the tool is skipped with the keyword `$ref` and no request is made |
| `pattern` | never turned into a value: the simplest value of the type is used and kept only if the schema check accepts it, so a tool with a `pattern` is built only when that simple value happens to match (`move_note` above, whose pattern is `^[a-z]+$`, got the value `a`); otherwise it is skipped with `pattern` |
| `not`, unsatisfiable schemas | skipped with the keyword |
| `$schema` other than `https://json-schema.org/draft/2020-12/schema` (with or without a trailing `#`) | the tool is skipped with `$schema` |
| a schema deeper than 32 levels, with more than 5000 nodes, or larger than 256 KiB as JSON | skipped with `limit` |
| two tools with the same exact name | both skipped (`name`) |
| a tool with no properties | no cases; the summary says so (`ping` above) |
| nested objects | built whole; only top-level properties get `wrong-type`, `boundary`, `branch` and `enum` cases |

Checking a schema runs in a worker thread with 2 seconds for each tool and 15 seconds for all tools together, because a
regular expression in a hostile schema cannot be interrupted where it runs. A tool that passes its limit gets no cases and
one `skipped` entry says the check took too long; tools not reached when the 15 seconds are spent are skipped with the
keyword `budget`. A case whose arguments contain a value that the secret masking would change (a value you passed with
`--env`, `--header` or in the address) is not written; it is listed under `skipped` as `value masked`.

### Adversarial styles

`--adversarial [styles]` takes any of `normal,curious,psycho,hacker`; a bare flag is all four. An unknown name is named on
stderr and ignored (it never widens the choice).

| style | what it does |
|---|---|
| `normal` | no new cases; tags the `valid` cases |
| `curious` | no new cases; tags the `all-params`, `enum` and `branch` cases |
| `psycho` | the largest safe integer and `-1` in the first numeric parameter; a long string (`--adversarial-max-string`, default 100000, at most 200000), an empty string, a string with a zero byte and a string with an unpaired surrogate in the first string parameter; an array nested to `--adversarial-max-depth` (default 100, at most 100) in the first array parameter; a property the schema forbids when `additionalProperties` is `false`; an own key `__proto__` |
| `hacker` | four harmless strings in the first string parameter: a piece of SQL, a script tag, a shell command substitution naming a command that does not exist, and a path that goes up to a name that does not exist. Each case says in its `rationale` that the string is "a harmless string that a careful server refuses or treats as plain text" |

At most 16 adversarial cases per tool and 200 per run; the rest are counted as cut. The first parameter of a kind is the
first by name. The expectation of these cases is about behaviour, not about rejection: a JSON-RPC error, a result with
`isError: true` or an answer that does no harm are all fine; the server dying, the connection closing, a hang or an HTTP
5xx is a failure. Whether a payload was handled *safely* no rule can decide, so those cases carry `humanOracle: true` and
are **never** passed automatically: at best they end in `needs-review`.

`psycho` and `hacker` are mutating styles for the call guard, because a careless server could paste the SQL-shaped
string into a statement that changes data and make its condition always true. That is why they need `--allow-mutations`
and the tool's name, and a test account.

## 3. Run the cases

### What each permission flag allows

| flag | allows | does not allow |
|---|---|---|
| (none) | nothing is called | — |
| `--allow-tools a,b` | calls to the tools with exactly these names (compared byte for byte; no `all`, no pattern, no empty name: such a value is a usage error). A named tool whose server claims it read-only and that nothing contradicts (rule below) is allowed at once, whatever its name is | a named tool that does not meet that rule, or whose name or title reads as a deletion, still needs `--allow-mutations`. A name the server does not have is an error (exit `1`) |
| `--allow-read-only-hints` | also the tools that pass the read-only rule below **and** have a plain ASCII name that starts with a read verb, without naming them | any other tool. It is trust in the server's claim, not a check |
| `--allow-mutations` | together with the tool's name: tools that do not meet the read-only rule below, deletions, and the `psycho` and `hacker` styles. Prints a banner | alone it allows nothing (`Note: --allow-mutations without --allow-tools allows nothing.`) |

The read-only rule decides whether a tool may be called without `--allow-mutations`. A tool meets it only when all of
these hold: `readOnlyHint` is `true`, `destructiveHint` is not `true`, the deletion words the crawler knows (English,
Ukrainian, Russian) find nothing in the name or the title, the name has no control or invisible characters, and no other
tool has the same name (or the same after normalization and case folding). The description plays no part, and neither
does the shape of the name: a tool called `send_email` with `readOnlyHint: true`, named in `--allow-tools`, is sent
without `--allow-mutations`, because the claim is the server's word and the guard checks only that nothing contradicts it.
The adversarial styles `psycho` and `hacker` are never sent on this rule: they need `--allow-mutations` too.

A tool that nobody named is held to more. `--allow-read-only-hints` lets it through only when it also meets the rule above
**and** its name is plain ASCII letters, digits, `_`, `-` and `.` and its first word (after splitting `getReport`,
`get_report`, `get-report` into words) is one of `get`, `list`, `read`, `search`, `find`, `describe`, `show`, `view`,
`fetch`, `query`, `count`, `check`, `lookup`, `status`. A tool that meets the rule but not this one is refused as `claim not
trusted`; naming it in `--allow-tools` lets it through. Names from the server are untrusted text: a name with control or
invisible characters, or two tools whose names are the same after case folding, are refused even when named.

Limits, all enforced before a call is sent:

| flag | default | meaning |
|---|---|---|
| `--max-calls <n>` | 100 | most calls sent (a retry would count; Cairn does not retry). When it runs out, the rest are not sent and the exit code is `4` |
| `--rps <n>` | 2 | calls per second (the re-read of the tool list before each call takes a slot too) |
| `--call-timeout <seconds>` | 30 | how long to wait for one call |
| `--time-budget <seconds>` | none | time for the whole run of calls; when it runs out, the remaining cases are `could-not-run` and the exit code is `4` unless a case failed |
| `--max-response-bytes <n>` | 262144 | the most bytes of one answer that is read (1 to 67108864, a plain decimal whole number) |

### Example: read-only tool by name

```text
cairn mcp-test --out runs/r3 --allow-tools search_notes -- node ./notes-server.mjs
```

Output (cut: the guard section lists one line per case, only the first lines of each kind are shown):

```text
[…]
▸ Running 32 case(s) through the call guard…
=== Run: 0 passed, 8 failed, 0 need review, 0 could not run, 24 not sent ===
=== Coverage: 1/7 tool(s) covered, 0 partial, 6 not measured ===
  uncovered create_note — params 0/2, enum values 0/3, branches 0/0, judged cases 0
  uncovered delete_note — params 0/1, enum values 0/0, branches 0/0, judged cases 0
  uncovered move_note — params 0/2, enum values 0/0, branches 0/0, judged cases 0
  uncovered ping — params 0/0, enum values 0/0, branches 0/0, judged cases 0
  covered   search_notes — params 2/2, enum values 0/0, branches 0/0, judged cases 8
  uncovered set_target — params 0/1, enum values 0/0, branches 0/2, judged cases 0
  uncovered tag_note — params 0/1, enum values 0/0, branches 0/2, judged cases 0
  Not measured (no case was sent and judged): create_note, delete_note, move_note, ping, set_target, tag_note
=== Call guard ===
  Policy: 1 tool(s) named, read-only hints not trusted, mutations not allowed; at most 100 call(s), 2/s.
  Sent: 8, refused: 24.
  refused create_note: mutations not allowed
  refused create_note: mutations not allowed
  […] (22 more `refused` lines left out)
  allowed search_notes: named in --allow-tools
  […] (7 more `allowed` lines left out)
exit 1
```

`search_notes` is claimed read-only and nothing contradicts it, so naming it was enough. The other tools were refused by the guard
(`mutations not allowed`, and `destructive name` for `delete_note`) and their 24 cases are `not-sent`. Eight cases were
sent and all eight failed, because this test server answers a success to everything: the three cases that should succeed
(`valid` and the two `boundary` cases on a limit) failed because the tool declares an `outputSchema` and the answer has no
`structuredContent`, and the five cases that should have been refused were accepted. The exit code is `1`.

### Example: a tool that can change data

```text
cairn mcp-test --out runs/r5 --allow-tools create_note --allow-mutations -- node ./notes-server.mjs
```

```text
[…]
▸ Running 32 case(s) through the call guard…
=== Run: 4 passed, 3 failed, 0 need review, 0 could not run, 25 not sent ===
=== Coverage: 1/7 tool(s) covered, 0 partial, 6 not measured ===
  covered   create_note — params 2/2, enum values 3/3, branches 0/0, judged cases 7
  uncovered delete_note — params 0/1, enum values 0/0, branches 0/0, judged cases 0
  uncovered move_note — params 0/2, enum values 0/0, branches 0/0, judged cases 0
  uncovered ping — params 0/0, enum values 0/0, branches 0/0, judged cases 0
  uncovered search_notes — params 0/2, enum values 0/0, branches 0/0, judged cases 0
  uncovered set_target — params 0/1, enum values 0/0, branches 0/2, judged cases 0
  uncovered tag_note — params 0/1, enum values 0/0, branches 0/2, judged cases 0
  Not measured (no case was sent and judged): delete_note, move_note, ping, search_notes, set_target, tag_note
⚠ Calls may change data: run this on a test account or a stand.
=== Call guard ===
  Policy: 1 tool(s) named, read-only hints not trusted, mutations allowed; at most 100 call(s), 2/s.
  Sent: 7, refused: 25.
  refused delete_note: destructive name
  refused delete_note: destructive name
  […] (23 more `refused` lines left out)
  allowed create_note: named in --allow-tools with --allow-mutations
  […] (6 more `allowed` lines left out)
exit 1
```

The banner is printed (and saved in `mcp-guard.json`). `create_note` does not meet the read-only rule, so it needed both its name
and `--allow-mutations`. Its server really received seven calls and keeps whatever they created.

### Example: the trust flag

```text
cairn mcp-test --out runs/r4 --allow-read-only-hints -- node ./notes-server.mjs
```

```text
=== Run: 0 passed, 8 failed, 0 need review, 0 could not run, 24 not sent ===
  […]
  Policy: 0 tool(s) named, read-only hints TRUSTED, mutations not allowed; at most 100 call(s), 2/s.
  Sent: 8, refused: 24.
  […]
exit 1
```

`Policy:` says `read-only hints TRUSTED`: that run rests on the server's claim, and the report says so. Only `search_notes`
passed the rule, so only its eight cases were sent.

### Example: a call without credentials (HTTP)

When the style `hacker` is on and the run reaches an HTTP server with headers, Cairn records once the call without
credentials for the first tool you named that has a valid case, and sends it through the guard with none of your headers.
A server that refuses (HTTP 401 or 403) passes the case. A server that answers it is a *finding*, not a failure, because the
server may be public; `--expect-auth` turns that finding into a failure. The call is not sent after the run was stopped or
a budget ran out.

```text
cairn mcp-test --out runs/h3 --url http://127.0.0.1:PORT/mcp --header "Authorization: Bearer example-token-1234567" --allow-tools search_notes --allow-mutations --adversarial hacker
```

```text
=== Run: 1 passed, 8 failed, 4 need review, 0 could not run, 44 not sent ===
  4 case(s) were answered but not judged: a person has to look.
  […]
⚠ Calls may change data: run this on a test account or a stand.
  […]
  Policy: 1 tool(s) named, read-only hints not trusted, mutations allowed; at most 100 call(s), 2/s.
  Sent: 12, refused: 44.
  […]
exit 1
```

In `report.json` the case `search_notes · no-credentials` is `passed`: the server answered 401 without the token.

## 4. Read the result

### Case states

| state | meaning |
|---|---|
| `passed` | the server answered as the case expects |
| `failed` | the server's own answer broke a rule written in the case, or its process exited during the call while it had been answering before |
| `not-sent` | the call guard refused it (a tool not allowed, a budget, a tool that changed since permission). Only the guard's refusal is `not-sent` |
| `could-not-run` | no answer, or an answer that cannot be judged (an HTTP 4xx status, a transport error, an answer that is not a JSON object): timeout, closed connection, server gone, an interrupt during the call, a tool list that could not be re-read, or the run stopped or ran out of `--time-budget` before it |
| `needs-review` | the server answered, but a person has to judge |

Rules of the verdict:

- **A valid case** passes on a success, and, when the tool declares an `outputSchema`, only if `structuredContent` is there
  and fits it (otherwise `failed`). A JSON-RPC error on a valid case is `failed`. A result with `isError: true` on a valid
  case is **`needs-review`, not `failed`**: the values of a generated valid case are made up, and a server may refuse them
  for a reason that has nothing to do with the schema (the reason text says so). The tool's `outputSchema` is compiled once
  per tool; a schema that cannot be checked (or whose check timed out) makes the tool's results `needs-review` for the rest
  of the run.
- **A case that is meant to be refused** passes only on what its `expect` lists: a JSON-RPC error with one of the listed
  codes (the generated cases list `-32602`) or an `isError` result. Any other error code is `needs-review` with the code
  named: the server refused, but not for the stated reason (an internal error on bad input is exactly what you want to see).
  If the server accepts the value, the case is `failed` ("the server accepted a value that violates its schema").
- **An adversarial case** follows its own `accepts` list literally (JSON-RPC error, `isError` result, accepted without
  harm); it fails only when the server dies, closes the connection, hangs past `--call-timeout` or answers HTTP 5xx while
  it had been answering before the case. A case with `humanOracle: true` ends in `needs-review` at best.
- **An answer over `--max-response-bytes`** is `needs-review` and is not stored.
- **A lost connection is told from a server's answer only by facts on this side:** this side's own timer firing, the
  transport reporting that it closed (for stdio, the child's exit), the run being interrupted, or the size counter. The
  number or text in an error the server sent never counts: a live server that answers `-32000`, `-32001` or the text
  "Connection closed" gave an ordinary error answer, judged by the case's rule.
- A stdio server that exits fails that case. Cairn starts it **once** more; a second loss stops the run (the remaining
  cases are `could-not-run`). Every result after the restart carries `afterRestart: true`, because the server lost the
  state the earlier cases made. A case that gets no answer is never sent again.
- Before every call the tool is read again (`tools/list`). A tool that changed since you looked (schema, description or
  `readOnlyHint`) is refused as `changed since permission`; a list that cannot be read means the call is not sent and the
  case is `could-not-run`.

Observations never change a state or the exit code. They are listed in `mcp-evidence.json`: empty content, text only, time,
size, and signs of a stack trace, a file path or SQL in an error text (heuristics; they only advise). Adversarial cases
answered with JSON-RPC `-32603` (internal error) are counted in the summary and in `report.json` as advice.

### Coverage

After a run Cairn prints the coverage per tool (the `=== Coverage ===` block above). A case that was **not sent** covers
nothing; neither does one that got no answer. A tool is `covered` when every declared parameter was sent by some case that
was sent and judged (`passed`, `failed` or `needs-review`), and every enum value and `oneOf`/`anyOf` branch of the
generated cases was; `partial` when some were; `uncovered` when no case of it was judged. Tools with no judged case are
listed by name under "Not measured", so "not measured" is never shown as covered.

`--min-coverage <percent>` makes the run exit `3` when the share of covered tools is lower; `--count-partial` counts
partial tools as covered. With no tools at all the gate never passes.

```text
cairn mcp-test --out runs/x3 --allow-tools echo --min-coverage 100 -- node ./my-server.mjs
```

```text
=== Run: 3 passed, 0 failed, 0 need review, 0 could not run, 12 not sent ===
  […]
=== Coverage gate: FAILED — 1/6 tool(s) = 16.6% (min 100%) ===
  ✗ uncovered crash
  ✗ uncovered hang
  ✗ uncovered plain
  ✗ uncovered shifty
  ✗ uncovered typed
  […]
exit 3
```

### Exit codes

| code | meaning |
|---|---|
| `0` | at least one case passed, and every other case that was sent passed too. Cases the guard refused (`not-sent`) are your choice and do not change the code; the summary states the counts |
| `1` | a case failed, or the run was stopped early, or a usage error, or the server could not be read |
| `3` | coverage below `--min-coverage` |
| `4` | a budget ran out (`--max-calls`, `--time-budget`) |
| `5` | not proven: no case passed, or a case could not run or needs a person, or the server has no tools |

When several apply the order is `1`, `3`, `4`, `5`: a failed case wins over a spent budget (the budget is still named in the
output). A run that stops with every answer unjudged is never green.

```text
cairn mcp-test --out runs/x0 --allow-tools echo -- node ./my-server.mjs
```

```text
=== Run: 3 passed, 0 failed, 0 need review, 0 could not run, 12 not sent ===
  […]
  Policy: 1 tool(s) named, read-only hints not trusted, mutations not allowed; at most 100 call(s), 2/s.
  Sent: 3, refused: 12.
  […]
exit 0
```

```text
cairn mcp-test --out runs/x4 --allow-tools echo --max-calls 2 -- node ./my-server.mjs
```

```text
=== Run: 2 passed, 0 failed, 0 need review, 0 could not run, 13 not sent ===
  […]
  Sent: 2, refused: 13.
  […]
  ✗ The call budget ran out: the rest were not sent and are not counted as passed.
exit 4
```

### Files of a run

All files are in the run folder (`runs/mcp-<id>/`, or the one you gave with `--out`). Everything written is masked first
(see [masking](#masking)).

| file | holds | arguments sent / answers |
|---|---|---|
| `mcp-model.json` | the server: `serverInfo`, protocol revision, `capabilities`, tools (schemas, hints), resources, resource templates, prompts; names of the `--header` and `--env` values, never the values | neither |
| `mcp-guard.json` | the tools' classes, every decision of the call guard (allowed or refused, why), the policy, the counts, the banner | neither |
| `mcp-cases.json` | the generated cases (`cases`), the adversarial ones (`adversarial`), what was cut and skipped, with the arguments each case would send | arguments generated, not yet sent; values the masking would change are not written |
| `mcp-calls.jsonl` | one line per call that really went to the server: time, tool, the guard's reason, the arguments (masked, cut to 300 characters), duration, result | arguments, no answers |
| `mcp-evidence.json` | one entry per case: state, reason, the arguments (masked), the answer (masked first, then cut to 4000 characters), size, observations, advice, `rpcCode`, `afterRestart` | both. An answer over the size limit is not stored |
| `report.json` | the shared artifact contract (`mode` is `explore`, `design`, `api` or `mcp`): `schemaVersion`, `runId`, `url`, `mode: "mcp"`, `mcp: {passed, total, toolCount}`, `states`, `guardrails`, `cases` (name, `stableId`, kind, state), `coverage`, `coverageGate`, `findings`, `advice`, `stdioSizeCounter`, `stopped`, `restarts`, `cost` (zero, no model) | neither |
| `report.md` | the same for people: the table of cases with state and reason, advice, findings, coverage | no |
| `testcases/ATC-MCP-NNN.md` | one document per case with the same front matter as the API ones (`id`, `stableId`, `title`, `suite`, `technique`, `type`, `execution`, `status`), the request (arguments cut to 500 characters) and the expected result | arguments, no answers |
| `server-stderr.log` | what the stdio server wrote to stderr, when it wrote anything, or when it failed to start (masked) | no |

`report.json` has `mode: "mcp"`: a program that reads run folders has to know that value. The cost is zero.

An excerpt of `report.md` from the run with `create_note` above:

```markdown
# Cairn — MCP run report

- **Server:** node
- **Run ID:** r5
- **Cases:** 4 passed, 3 failed, 0 need review, 0 could not run, 25 not sent

## Cases (32)

| state | tool | case | why |
|---|---|---|---|
| ✓ passed | create_note | create_note · valid · required | the server answered a success |
| ✗ failed | create_note | create_note · missing-required · body | the server accepted a value that violates its schema |
| ✗ failed | create_note | create_note · missing-required · kind | the server accepted a value that violates its schema |
| ✗ failed | create_note | create_note · wrong-type · body | the server accepted a value that violates its schema |
| … |
```

An excerpt of `mcp-evidence.json`, from a run against a server that puts a secret into its answer (the value
`example-secret-value-123` was given with `--env`, and the answer also has a key called `apiKey`):

```text
cairn mcp-test --out runs/x6 --allow-tools echo --env FIXTURE_ECHO=leak --env FIXTURE_LEAK=example-secret-value-123 -- node ./my-server.mjs
```

```json
{
  "name": "echo · valid · required",
  "stableId": "373475b991dd",
  "tool": "echo",
  "passed": true,
  "state": "passed",
  "reason": "the server answered a success",
  "durationMs": 7,
  "request": "{\"q\":\"a\"}",
  "response": "{\"content\":[{\"type\":\"text\",\"text\":\"value ***\"}],\"structuredContent\":{\"apiKey\":\"***\",\"note\":\"***\"}}",
  "responseBytes": 159,
  "observations": [
    "answer 159 bytes in 7 ms"
  ],
  "advice": []
}
```

The value under the sensitive key and the value you passed with `--env` are `***` on disk; the same `***` is on the console.

### Masking

Header and environment values are never stored; the model keeps their names only. What is masked, in the console, error
messages and files (string values only; keys, numbers and booleans are never touched): a value whose name is sensitive
(`Authorization`, `*key*`, `*token*`, `*secret*`, `*password*`, cookies) from 4 characters, with the credential part of
`Bearer x`, a Basic pair and cookie values; a value under any other name from 8 characters; also their URL-encoded forms.
Common values (`true`, `application/json`) are never masked. Consequences: a value shorter than 8 characters under a
neutral name is not masked; a long ordinary word passed as a value is replaced wherever the server repeats it. Not covered:
other encodings of a secret (base64, HTML), a secret that is part of the address path (only the user, password and
sensitive query values of `--url` are masked), and the command arguments after `--`: pass secrets with `--env`. Answers
are masked before they are cut, so a secret on the cut is never left as a prefix.

What a server writes (names, descriptions, answers) is untrusted text: it is printed with control characters removed and
is never run or handed to a model as an instruction. A line that would start with `::` or `##[` is prefixed, so a CI log
does not read it as a workflow command.

## What a pass does not prove

- **The cases come from the schema, not from what the tool means.** `passed` says the server answered as the schema
  predicts. It does not say that `create_note` creates the right note, or that a search finds the right notes.
- **Payload cases need a human oracle.** The `hacker` strings and the `psycho` values show whether the server survives them;
  whether it handled them *safely* (no injection, no stored script) only a person can say. These cases are never passed
  automatically.
- **Advice is a heuristic.** Signs of a stack trace, a path or SQL in an error text are found by simple patterns. They can
  miss and they can be wrong; they never change a state or the exit code.
- **Not a security scanner, not a protocol conformance check, not a test of the model that uses your server.** It checks a
  tool's answers against its own schema and a few fixed behaviours.
- **Not every schema can be built** (see the table above); the rest is listed as skipped, not hidden. A tool with no
  properties gets no cases.
- **The size limit has gaps on stdio.** The child's output is counted per message; the reader refuses to buffer more than
  the larger of `--max-response-bytes` and 1 MiB, and the child is stopped when one message passes it. A message between
  the limit and 1 MiB is parsed before it is judged, and a `tools/list` page above the cap ends the connection (the run
  then restarts the server, as after an exit). Over HTTP every response is bounded: the call's limit for a call, and 8 MiB
  for `initialize`, a `tools/list` page or a notification stream.
- **The stdio counter depends on a private field of the SDK transport.** If an SDK version lacks it, the run prints
  `the stdio size counter is unavailable with this SDK version: only the transport's own limit applies`, writes
  `stdioSizeCounter: "unavailable"` in `report.json`, and the child may keep writing until the transport's own refusal
  closes it. Over HTTP the counter is always `active`. After a restart that failed, the value of the last connection that was
  alive is kept.
- **One restart.** A stdio server that dies is started once more; results after that are marked `afterRestart` and ran
  against a server that lost its state.
- **A tool the server changes mid-run** is refused from then on, so the rest of its cases are `not-sent`.
- **Processes.** Cairn asks the server to stop (stdin closed), then kills it. On Windows its process tree is killed if it is
  still running; on Linux and macOS only the direct child is, so a grandchild the server started (a shell wrapper, `npx`)
  can outlive the run.
- OAuth is not supported. A 401 stops the run; pass a token with `--header`. A request goes to the origin you named only:
  authentication metadata on another origin is not visited, no token is sent there, and a redirect (3xx) is an error.

## Troubleshooting

Messages copied from real runs. Folders named `runs/…` are the ones given with `--out` in the examples.

| You see | Why | What to do |
|---|---|---|
| `✗ --allow-tools names tools the server does not have: "nope". Names are compared exactly (case and spaces included).` | `--allow-tools` has a name the server does not list | check the exact spelling, case and spaces count |
| `--allow-tools takes exact tool names; "all" is not accepted (no "all", no patterns).` | a pattern or `all` was given | name each tool |
| `--max-response-bytes must be from 1 to 67108864 (got 0).` | a limit outside its range | give a plain whole number inside the range |
| `--call-timeout must be a number greater than 0 (got "0").` | a timeout that is not a positive number | give seconds above 0 |
| `✗ The server requires authentication (HTTP 401). OAuth is not supported here; pass a token with --header "Authorization: Bearer <token>".` | the server answers 401 | pass a token: `--header "Authorization: Bearer <token>"` |
| `✗ Nothing to test: the server has no tools (t4). This is not a pass.` (exit `5`) | the server lists no tools | the server did not declare the tools capability, or it lists none |
| `✗ The server closed the connection before it answered initialize.` | the command does not start the server; the lines after it are the server's own stderr | run the same command by hand |
| `✗ Nothing was proven: no case passed (none was sent, or every answer needed a person or never came). This is not a pass.` (exit `5`) | `--allow-mutations` was given without a tool name | add `--allow-tools <name>` |
| `⚠ --adversarial: unknown style "hackr" is ignored (styles: normal, curious, psycho, hacker).` | a misspelt style | styles are lower-case: `normal`, `curious`, `psycho`, `hacker` |
| `✗ The call budget ran out: the rest were not sent and are not counted as passed.` (exit `4` or `1`) | `--max-calls` was too small for the cases | raise it; the exit code is `1` when a case also failed |

When the guard refuses a case, the reason is in `report.md` and `mcp-guard.json`. The reasons are: `not allowed` (the tool is
not named and not trusted), `mutations not allowed`, `destructive name`, `not in the model`, `ambiguous name`,
`unsafe name`, `claim not trusted`, `changed since permission`, `budget exhausted` and `time budget exhausted` (the last
one is shown as `could-not-run` in the report).

## Flag reference

The list comes from `cairn mcp-test --help`.

| flag | default | purpose |
|---|---|---|
| `--url <address>` | - | Streamable HTTP: the server address (instead of a command) |
| `--header <header>` | - | Streamable HTTP: request header 'Name: Value' (repeatable); values are never saved or printed |
| `--env <KEY=VALUE>` | - | stdio: environment variable for the server (repeatable); values are never saved or printed |
| `--cwd <dir>` | - | stdio: working directory of the server |
| `--timeout <seconds>` | `30` | how long to wait for the server to start and answer the handshake and each list request; it does not bound a tool call (that is `--call-timeout`) |
| `--out <dir>` | `runs/mcp-<id>/` | where to write the files of the run |
| `--max-pages <n>` | `20` | most pages to read from one list; a list cut short is marked complete: false |
| `--max-entries <n>` | `1000` | most entries to keep from one list; a list cut short is marked complete: false |
| `--allow-tools <names>` | - | tool calls: exact tool names that may be called, comma separated (no patterns, no 'all'); by default no tool is called |
| `--allow-read-only-hints` | - | tool calls: also allow tools whose server claims readOnlyHint (a claim of the server, not a check) |
| `--allow-mutations` | - | tool calls: also allow tools that are not proven read-only, but only those named in --allow-tools; may change data, use a test account |
| `--max-calls <n>` | `100` | tool calls: most calls sent, retries included; exit code 4 when it runs out |
| `--rps <n>` | `2` | tool calls: calls per second |
| `--call-timeout <seconds>` | `30` | tool calls: how long to wait for one call; a call with no answer by then is `could-not-run`, never `failed` |
| `--min-coverage <percent>` | - | tool calls: exit 3 when fewer than this share of tools are covered |
| `--count-partial` | - | tool calls: with --min-coverage, count partially covered tools as covered |
| `--max-response-bytes <n>` | `262144` | tool calls: the most bytes of one answer that is read, 1 to 67108864 |
| `--time-budget <seconds>` | - | tool calls: time for the whole run of calls; exit code 4 when it runs out |
| `--max-cases-per-tool <n>` | `12` | cases: most cases kept per tool; the rest are listed as cut with a count |
| `--examples <file>` | - | cases: JSON file {"tool": {arguments}} giving the arguments of the valid case; a value the tool's inputSchema refuses is an error |
| `--adversarial [styles]` | - | adversarial cases: normal,curious,psycho,hacker (psycho and hacker are sent only with --allow-mutations and the tool named); a bare flag is all four, an unknown name is reported and ignored |
| `--adversarial-max-string <n>` | `100000, at most 200000` | adversarial: length of the long string |
| `--adversarial-max-depth <n>` | `100, at most 100` | adversarial: nesting of the deep array |
| `--expect-auth` | - | adversarial: a call without credentials that goes through is a failure, not a finding |

## See also

- [`cairn mcp`](./mcp.md): Cairn as an MCP server for other agents.
- [Runbook: test an MCP server](./runbooks/test-an-mcp-server.md): the same path as a checklist.
- [Runbook: run API cases](./runbooks/run-api-cases.md) and [API flows](./api-flows.md): the same ideas for an HTTP API.
