# Langfuse (optional)

Langfuse is **entirely optional** — leave the `LANGFUSE_*` variables unset and the bot runs fully offline.
Everything core still works: `observe` / `design` / `automate` / `explore`, locator grounding, the LLM judge,
deterministic scorers, self-repair, and results-level learning (best cases are read from local
`runs/<id>/report.json`). Prompts fall back to the built-in defaults — override any of them with `./prompts/<name>.md`
(see [Prompts & styles](prompts-and-styles.md)).

Set the three `LANGFUSE_*` variables to **additionally** get: traces in the Langfuse UI, scores/datasets
recorded centrally, and versioned prompts (with production labels & A/B prompt experiments via `cairn experiment`).

Tracing ships as an **optional add-on** (0.3.3): the `@langfuse/*` / `@opentelemetry/*` packages are no
longer part of the default install — that keeps the footprint small and `npm audit` clean. Install them
once to enable it:

```bash
npm install @langfuse/client @langfuse/langchain @langfuse/otel @langfuse/tracing @opentelemetry/api @opentelemetry/sdk-node
```

If the `LANGFUSE_*` variables are set but the packages aren't installed, Cairn prints a one-line hint and
keeps running **without** tracing — it never crashes a run over telemetry.

**Cloud or self-hosted — same setup.** Langfuse Cloud and a self-hosted instance are configured identically:
you only pass the host URL and the API keys, nothing else changes.

```bash
# Pick ONE base URL:
LANGFUSE_BASE_URL=https://cloud.langfuse.com       # Langfuse Cloud (EU)
# LANGFUSE_BASE_URL=https://us.cloud.langfuse.com  # Langfuse Cloud (US)
# LANGFUSE_BASE_URL=https://langfuse.your-host.tld # self-hosted
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

> Enablement is all-or-nothing: Langfuse turns on only when **all three** variables are set; otherwise
> telemetry is a no-op and the bot behaves exactly as offline.
