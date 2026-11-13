# Runbook: test an MCP server

> Read a server, look at the cases Cairn builds from its schemas, run a few of them on a **test account**, and read the
> result. The full explanation, with real outputs, is [`docs/mcp-test.md`](../mcp-test.md). This is the checklist.
> (`cairn mcp` is the other direction: Cairn as a server. See [`mcp.md`](../mcp.md).)

## Before you start

- You need the MCP client package once: `npm i @modelcontextprotocol/sdk` (the command says so when it is missing).
- Have a **test account on a test server**. Calls run on the server you name and can change data; Cairn undoes nothing.
- Put secrets in `--env KEY=VALUE` (stdio) or `--header "Name: Value"` (HTTP), never in the command after `--`. Their values
  are not saved or printed.

## Steps

1. **Read the server (nothing is called).**
   ```bash
   cairn mcp-test --out runs/first -- node ./my-server.js
   cairn mcp-test --out runs/first --url http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"
   ```
   → prints the tools, how the call guard classes each (`read-claimed`, `unknown`, `mutating`), and a summary of the cases
   built from the schemas. Files: `mcp-model.json`, `mcp-cases.json`, `mcp-guard.json`. Exit `0`; `1` if the server could
   not be read; `5` if it has no tools.
2. **Look at the cases.** Open `mcp-cases.json`. A line under `Skipped` names a schema keyword Cairn could not build a case
   from (for example `pattern`, a non-local `$ref`); it is listed, not hidden. Add `--adversarial` to also get the
   awkward-value cases (still nothing is sent).
3. **Allow one read-only tool by name and run.**
   ```bash
   cairn mcp-test --out runs/second --allow-tools search_notes -- node ./my-server.js
   ```
   Only the named tool is called; the other cases are `not-sent`. A tool whose server does not claim it read-only (or whose name reads as a deletion)
   needs `--allow-mutations` too, and `psycho` / `hacker` cases always do.
4. **Read the result.** The console prints the counts per state, the coverage per tool and the guard's decisions.
   `report.md` has one row per case with the reason; `mcp-evidence.json` has the masked arguments and answers. States:
   `passed`, `failed`, `not-sent`, `could-not-run`, `needs-review`.
5. **Decide what each non-pass means.** `failed`: the server's own answer broke the case's rule (read the reason).
   `needs-review`: answered, but a person has to judge (an `isError` on a made-up valid value, an error the case does not
   list, an answer over `--max-response-bytes`, a payload case). `could-not-run`: no answer. `not-sent`: the guard refused
   it (your choice).
6. **Gate it (optional).** `--min-coverage 100` exits `3` when fewer than all tools are covered; `--count-partial` counts
   partly covered tools. Exit codes: `0` all sent cases passed, `1` failed or stopped, `3` coverage, `4` budget
   (`--max-calls`, `--time-budget`), `5` not proven. Order of precedence: `1`, `3`, `4`, `5`.

## Guardrails

- By default no tool is called. `--allow-tools`, `--allow-read-only-hints` and `--allow-mutations` are the only ways to send
  a call; `--allow-mutations` alone allows nothing.
- `--allow-read-only-hints` trusts the server's own `readOnlyHint` claim. It is not a check.
- Limits you can set: `--max-calls` (100), `--rps` (2), `--call-timeout` (30 s), `--time-budget`, `--max-response-bytes`
  (262144).
- What a pass does not prove is listed in [What a pass does not prove](../mcp-test.md#what-a-pass-does-not-prove).

## Troubleshooting

See the table in [`mcp-test.md`](../mcp-test.md#troubleshooting), built from the messages the command prints.
