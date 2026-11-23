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

## Trace link in `report.json`

With tracing on, `explore` and `design` write the link to the run's trace into `report.json`: every case under
`testCases` gets a `traceUrl`, the address of the trace in the Langfuse UI.

```json
{ "id": "tc-1", "stableId": "3f9c2a71b0de", "title": "…", "traceUrl": "https://cloud.langfuse.com/project/<project id>/traces/<trace id>" }
```

- A run is one trace, so all cases of a run carry the same link.
- It needs no setting beyond the three `LANGFUSE_*` variables: the address is `LANGFUSE_BASE_URL` plus the project
  the keys belong to (asked from the server once, at the end of the run) plus the trace id.
- Without tracing the key is absent. It is never empty.
- The link is written only when it is an `https` address with no user name, password or key in it and at most
  2048 characters. Otherwise, or when the server does not give the project within 5 seconds, the cases have no
  `traceUrl` and the run prints one line starting with `trace link — not written to the report:`. A self-hosted
  server reached over `http://` is traced as before, but gets no link.
- `api` and `mcp-test` runs are not traced and write no `traceUrl`.

## Decision layer

With a [decider](decider.md) on, each of its calls is a span `decider.<use>` (`decider.repair-triage`,
`decider.coverage`) directly under the run's root span. `explore` and `design` are traced; `automate` is not. Its
input is the scrubbed state (the first 2 000
characters) and the questions, its output the answers, its metadata the provider, model, latency and confidence
threshold. A call that fell back — timeout, server error, an input over the provider's limits, an invalid answer —
is a `WARNING` span whose status message is the reason, so filtering a trace by level lists every fallback.

| Score | Attached to | Value |
|---|---|---|
| `decider.<use>.confidence` | the call's span | the lowest confidence among the call's answers; none after a fallback |
| `decider.<use>.agreement` | the run's trace, shadow mode only | 1 when the decider's coverage is within 0.1 of the LLM judge's, else 0; none when the judge failed or the decider did not decide. Only `coverage` has one: today's path does not classify failures |

A confidence describes the shape of an answer's distribution, not the chance that it is right. Without Langfuse,
`report.json` keeps the counts (`decider`: calls and fallbacks) and what the answers changed: the tests triage kept
out of repair (`notRepaired`) and a coverage score the decider set. It keeps no per-call answer. In shadow mode `report.json` has no `decider` key;
`runs/<id>/decider-shadow.json` (`decider-shadow-automate.json` for `automate`) keeps every answer with its
confidence and latency.
