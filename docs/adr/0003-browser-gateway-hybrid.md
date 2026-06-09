# ADR-0003: Hybrid BrowserGateway (playwright-lib PRIMARY + playwright-cli SECONDARY)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision in code:** `src/browser/gateway.ts`, `src/browser/backends/*`

## Context

The bot must simultaneously: (a) **interactively navigate** the page (where token-efficient ref snapshots shine),
and (b) **emit and run** `@playwright/test` code (where full control and the same ecosystem are needed).
The user explicitly chose: "Playwright directly + a wrapper over playwright-cli".

## Decision

A single **`BrowserGateway`** interface (`observe`/`act`/`session`/`runTests`/`close`) over two backends:

- **PRIMARY = `playwright` (the library, in-process):** owner of `storageState` (cookies+localStorage),
  `ariaSnapshot()`, `screenshot()`, **and `runTests()`** (running the generated tests).
- **SECONDARY = a wrapper over `@playwright/cli`:** token-efficient `observe`/`act` for the agentic loop.

**Routing contract:** `observe`/`act` → the backend per `config.browser.backend`; `runTests` and `session`
→ **ALWAYS playwright-lib** (the CLI doesn't run tests). Even in `cli` mode the gateway keeps a lib instance.

## Consequences

- (+) The driver = the output format → no "seam" between exploration and generation; tests are validated immediately.
- (+) Everything in-process in TS (lib) + optional token efficiency (cli) — without a Rust binary.
- (+) A backend-agnostic interface → `playwright-mcp` remains a drop-in alternative to SECONDARY.
- (−) The `@playwright/cli` boundaries (snapshot format, ref scheme, whether it returns emitted code) need to be determined —
  **Spike S3** (Sprint 1).
- (−) Two observation implementations → a risk of shape divergence; covered by a contract test (`PageStudy` parity).

## Rejected alternatives

- **playwright-lib only** — simpler, but we lose the token-efficient agentic loop the CLI provides.
- **agent-browser (Vercel, Rust):** the ref system is good, but it's an external binary + shell, and Playwright is still needed
  for codegen/validation. Outside the Playwright ecosystem.
- **Playwright MCP as the primary:** heavier on tokens per page; better suited for integration into Claude Desktop.
  Kept as a possible replacement for SECONDARY.
