# MCP server — Cairn as a tool for Claude Code / Cursor

Cairn exposes its core as an [MCP](https://modelcontextprotocol.io) server, so other agents (Claude
Code, Cursor, …) can call **“generate / maintain tests for this target”** as a tool. It is a thin
wrapper over the same core the CLI uses — no separate generation logic.

## Run

```bash
cairn mcp
```

This starts an MCP server over **stdio** (the transport MCP clients launch as a child process). The
`@modelcontextprotocol/sdk` package is an **optional dependency** (like Ink for the TUI) — install it
once if you haven't:

```bash
npm i @modelcontextprotocol/sdk
```

## Tools

| Tool | What it does | Returns |
|------|--------------|---------|
| `explore` | Explore a page → methodology-based cases → `@playwright/test` code → validate ⇄ repair | cases, validation summary, metrics, Pilot verdict, cost, run dir |
| `design`  | Explore a page → cases in ATC/MTC format, **no code** | cases, metrics, cost, run dir |

Both take the same input: `url` (required) plus optional `session`, `flow`, `setup`, `gaps`,
`critique`, `fresh`, `checklist`, `style`, `routing`, `backend`, `channel`, `maxPages` — mirroring the
matching `cairn explore` flags. Results come back as JSON (run id, the generated cases, validation /
metrics / Pilot, cost, and the `runs/<id>/` directory).

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
