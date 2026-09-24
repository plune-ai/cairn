# Configuration (env)

| Var | Purpose |
|---|---|
| `LLM_PROFILE` | `anthropic` \| `openrouter` \| `mixed` (per-tier default models) |
| `LLM_ROUTING` | per-role preset: `fast` (Groq worker) \| `volume` (OpenRouter worker) \| `volume-fast` (Anthropic codegen) — see [Role routing](#role-routing) |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` | provider keys (per profile / routing) |
| `STEP_TIMEOUT_MS` | per-step LLM timeout in ms (default `240000` = 4 min; `0` disables) — see [Provider latency](#provider-latency) |
| `QA_TESTCASE_LANG` | test-case language (default `English`; e.g. `Ukrainian`, `uk`) |
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse — **cloud or self-hosted** (optional; see [Langfuse](langfuse.md)) |
| `BROWSER_BACKEND` | `lib` (in-process Playwright) \| `cli` |
| `BROWSER_CHANNEL` | `chrome`/`msedge` → drive a system browser (helps with OAuth; **no bundled-Chromium download**, and coexists with a host project's own Playwright). Per-command flag: `--channel`. |
| `MAX_REPAIR` | repair attempts (default 2) |
| `DECIDER` | opt-in decision layer: `off` (default) \| `jev` \| `laya` \| `compat` — see [Decision layer](#decision-layer). Per-command flag: `--decider`. |

- **Env var prefix:** every variable above is read as-is **or** with a `CAIRN_` prefix (e.g. `CAIRN_LLM_PROFILE`, `CAIRN_MAX_REPAIR`). Legacy `LEX_`/`LEXBOT_` prefixes still work but print a one-time deprecation warning — prefer `CAIRN_`.
- <a id="role-routing"></a>**Role routing (`LLM_ROUTING`, optional):** layer a cheap **worker** over any profile while keeping the strong **reasoner**. One flag picks where the mechanical steps (identify-elements, generate-code/repair) run:
  - `fast` → worker on **Groq** `llama-3.3-70b-versatile` — lowest latency/cost, OpenAI-compatible tool-calling. ⚠ Groq 400s on large-codegen `json_schema` (`groq-fast-json-schema-bug`) — fine for design, not a codegen escape.
  - `volume` → worker on **OpenRouter** `deepseek/deepseek-chat` — model breadth, but **slow on large codegen** (4.5–13 min, see [Provider latency](#provider-latency)).
  - `volume-fast` → worker on **Anthropic** `claude-sonnet-4-6` — the latency-safe sibling of `volume`: codegen finishes in ~90 s while the cheap `judge` scorer still runs on OpenRouter via `LLM_PROFILE`. **Recommended when OpenRouter codegen overruns timeouts (#110).**
  - default (unset) → the profile's own per-tier models.

  In **every** preset the reasoner (design test cases + Pilot verdict) stays on **Anthropic** `claude-opus-4-8` for judgment quality, and the cheap `judge` scorer keeps the profile tier (routing never touches it). Override any role with `CAIRN_ROLE_WORKER` / `CAIRN_ROLE_REASONER=provider:model`; pass `--routing <preset>` on `explore`/`design`/`automate` to set it per run. Per-run **per-role cost** (tokens + $) is printed in the run summary.
- <a id="provider-latency"></a>**Provider latency & per-step timeout (`STEP_TIMEOUT_MS`, #110):** providers differ by minutes per step. Measured on `https://plune.ai/`: Anthropic `claude-opus-4-8` design ≈ **90 s** (finishes); OpenRouter `deepseek-chat` codegen ≈ **4.5–13 min**; OpenRouter `deepseek-r1` design **overran 4 min without finishing**. Each structured call is bounded by `STEP_TIMEOUT_MS` (default `240000`); on overrun the step fails with an **actionable error** (try a faster `--routing` such as `volume-fast`, or `LLM_PROFILE=anthropic`, or raise `STEP_TIMEOUT_MS`) instead of hanging. `0` disables the timeout. **MCP guidance:** the MCP caller (Claude Code / Cursor) sees a timeout as a clean tool error — keep `STEP_TIMEOUT_MS` at/under your client's tool timeout, and prefer the `volume-fast`/`anthropic` paths for interactive MCP use.
- <a id="decision-layer"></a>**Decision layer (`DECIDER`, optional — [ADR-0022](adr/0022-optional-decision-layer.md), guide: [decider.md](decider.md)):** a System One model (TypeSafe **Jev** in the cloud, **Laya** on your machine, or any Jev-compatible server) answers the pipeline's pick-from-a-list questions. **Off unless `DECIDER` names a provider — a key alone changes nothing.** With it off, a run is byte-identical to one without the feature.

  | Var | Default | Meaning |
  |---|---|---|
  | `DECIDER` | `off` | `jev` \| `laya` \| `compat` (`--decider` overrides it) |
  | `DECIDER_BASE_URL` | — | **laya / compat only** (required), e.g. `http://127.0.0.1:8000` |
  | `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | **jev only** — TypeSafe's address, the TypeSafe SDK's own variable; only an `https://*.typesafe.ai` address is accepted |
  | `DECIDER_MODEL` | `jev-latest` | laya picks its checkpoint by language unless you pin one (`multilingual` for non-English apps) |
  | `TYPESAFE_API_KEY` | — | **jev only** (required) |
  | `LAYA_API_KEY` | — | **laya only** — the bearer token `laya-serve` was started with |
  | `DECIDER_API_KEY` | — | **compat only** |
  | `DECIDER_USES` | `repair-triage` (shadow mode: every use point) | use points to enable: `repair-triage`, `coverage`, `locator-heal`; `coverage` and `locator-heal` act only when named here, and `locator-heal` needs `repair-triage`; an unknown name is an error, not a silent no-op |
  | `DECIDER_MIN_CONFIDENCE` | `0.75` | below it an answer is ignored and the current path runs |
  | `DECIDER_TIMEOUT_MS` | `10000` | per call, one retry on 429/5xx included |
  | `DECIDER_MAX_CALLS` | `200` | per-run ceiling on decisions — a retry on 429/5xx belongs to its decision (separate from the LLM call budget) |
  | `DECIDER_SHADOW` | `0` | `1` = shadow mode: ask, record the answers in `runs/<id>/decider-shadow.json`, act on none (`--decider-shadow`); needs a provider |

  Each provider reads only its own address and key — jev the TypeSafe pair (`TYPESAFE_BASE_URL` + `TYPESAFE_API_KEY`), laya and compat `DECIDER_BASE_URL` + their own key — so a TypeSafe key is never sent to a laya or compat address, even one left in `.env`; and jev refuses any address outside `https://*.typesafe.ai` — a `TYPESAFE_BASE_URL` pointing at a laya-serve means `DECIDER=laya`. To reach TypeSafe on such a machine, set `CAIRN_TYPESAFE_BASE_URL` and `CAIRN_TYPESAFE_API_KEY` together: the `CAIRN_` names win, and the address without its key is an error, so the SDK's local token never travels to TypeSafe. `cairn doctor` shows the provider, **where the data goes**, and the latency of one real call. A misconfiguration (`jev` without a key, `laya`/`compat` without a URL, an unknown use) fails at start.
- **Domain knowledge:** put `*.md` files in `./knowledge/` with a `url:` front-matter to inject credentials/validation rules into design.
- **Prompt overrides & house-style:** drop `./prompts/<name>.md` to override any built-in prompt, and use `--style` to load a house-style pack — see [Prompts & styles](prompts-and-styles.md).
