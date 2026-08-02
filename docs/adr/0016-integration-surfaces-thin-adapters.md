# ADR-0016: Integration surfaces (MCP, CI/PR bot, `--into-project`) are thin adapters over the core

- **Status:** Accepted
- **Date:** 2026-06-24 (`cairn mcp`) → 2026-06-25 (`cairn ci` + GitHub Action, `--into-project`)
- **Decision in code:** `src/mcp/`, `src/ci/`, `action/`, `src/project/`
- **Applies from:** 0.5.0 · **Issues:** #49 (MCP), #50 (CI/PR bot), #51 (`--into-project`) · **PRs:** #109, #112, #113
- **Relationship to prior ADRs:** applies ADR-0007's "one layered package, boundaries by directory" to a new class of module, and reuses ADR-0009's optional-dependency pattern (Ink/React) for `@modelcontextprotocol/sdk`.

## Context

Through 0.4.x Cairn had exactly one way in — a human typing `cairn` — and one place out: `runs/<id>/`.
Three demands arrived in the same week, and they looked like three different features:

- **#49** — other agents (Claude Code, Cursor) should be able to call test generation as a tool.
- **#50** — a pull request should get generated tests and a summary comment without anyone typing anything.
- **#51** — the output should land in an existing Playwright project's own `testDir`, in its conventions,
  not in a greenfield folder the user then has to move files out of.

The risk was three parallel implementations, each re-deriving config, routing, cost and run orchestration —
and each free to drift into slightly different generation behaviour. The second risk was dependency weight:
an MCP SDK and a GitHub API client are irrelevant to someone who only wants a CLI or a library import.

## Decision

**Every integration surface is a thin adapter over the public core. It adds no generation logic.**
Four rules, applied to all three surfaces:

1. **One subcommand per surface, over the same entry points.** `cairn mcp` and `cairn ci` mirror each other:
   inputs are mapped onto the *same* `runExploration` / `runDesign` / `runAutomate` the CLI uses, through the
   same `resolveConfig` (config, routing, cost). A surface never reaches past the public API.
2. **Heavy or host-specific dependencies are optional and lazily imported.**
   `@modelcontextprotocol/sdk` is an `optionalDependency`, loaded only on the `cairn mcp` path — the same
   treatment Ink/React got in ADR-0013. The CI bot goes further and adds **no** dependency: its GitHub client
   is ~170 lines of `fetch` against the REST and Git Data APIs, not Octokit.
3. **Side effects sit behind an injectable seam.** MCP handlers take a `ToolDeps` core; the CI bot takes a
   `GitHubClient`. Both are therefore unit-testable with no browser, no LLM and no network — which is how
   comment idempotency, the changed-surface gate, and fork safety are actually covered by tests.
4. **A surface that cannot safely act declines and says why, rather than failing.** Fork PRs and missing
   tokens skip write effects with a logged reason. `--into-project` with no `playwright.config.*` found logs
   the fallback and writes greenfield. Nothing here turns a missing integration into a failed run.

### Per surface, the decisions that are not shared

**MCP server** — three tools (`explore`, `design`, `automate`) over `StdioServerTransport`, which is what
Claude Code and Cursor speak locally and needs no listening socket. `automate` takes a run directory instead
of a URL, so the decoupled `design → automate` flow (ADR-0005) survives across tool calls.

**CI / PR bot** — a **composite** GitHub Action wrapping `cairn ci` as a subprocess, not a JavaScript action
bundling the tool. v1 is *generation-on-PR*: run, post an **idempotent** summary comment (marker-based
upsert, so re-running a job edits the comment instead of stacking a new one), and — only when explicitly
toggled — open a follow-up PR with the generated tests. A `paths` gate skips runs whose changed files touch
no relevant surface. Provider keys come from env/secrets through `resolveConfig`; nothing is hardcoded.

**`--into-project`** — detection walks up for `playwright.config.{ts,js,mjs,cjs}` and best-effort parses
`testDir` and the `.spec.ts`/`.test.ts` suffix from `testMatch`. The safety rule is the load-bearing part:
**validation and repair stay in an isolated `runs/<id>/tests` sandbox** — the same Playwright, identical
result — so the user's own suite is never run and never deleted. Only after convergence are the specs placed
into the project's `testDir`, and **a pre-existing spec is never overwritten** (Cairn writes
`login.cairn.spec.ts` beside it). Generated specs are self-contained — each imports `@playwright/test`
directly, with no inter-file POM imports — so a collision rename cannot break an import.

## Consequences

- **Generation behaviour cannot drift per surface.** A fix in the core reaches the CLI, MCP, CI and library
  embedders at once, because there is only one implementation to fix.
- **Install weight is unchanged for people who use none of this.** Optional deps, lazy imports, zero new
  dependencies for CI.
- **Cairn now ships its own GitHub Action, and Plune ships `eval-action`.** They are different jobs — Cairn's
  *generates tests on a PR*, Plune's *evaluates and diffs runs* — but the overlap in the name space is real
  and worth stating out loud so nobody merges them by accident.
- **Three more public surfaces to keep compatible.** The CLI `--help` snapshot test locks the flag surface;
  the MCP `tools/list` smoke test locks the tool surface. Both fail loudly on an accidental change.
- **The CI bot's REST client is ours to maintain.** ~170 lines against endpoints GitHub has kept stable for
  years, in exchange for zero dependency weight in the default install. Revisit if it grows past
  comment upsert, changed-file listing and the Git Data PR flow.

## Rejected alternatives

- **A JavaScript GitHub Action bundling Cairn.** Ties the action's release cycle to a bundle rebuild and
  hides which version actually ran. A composite action calling the published CLI shows the version in the log.
- **Octokit in the CI bot.** A large dependency tree for three endpoints, in a package whose default install
  weight is a stated concern (ADR-0009, ADR-0013).
- **HTTP/SSE transport for MCP.** Would need a listening port and an auth story for a tool whose callers are
  local editors. stdio is what they already speak.
- **Making MCP re-implement the flags as tool inputs.** The tools accept a *subset* of the flags, mapped onto
  the same core call. Re-deriving the surface would have created a second definition of what a run is.
- **Writing generated specs straight into the host project and validating there.** Would mean running and
  deleting files inside a user's own suite. The sandbox costs one directory and removes that entire class of
  accident.
