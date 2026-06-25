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

- **Env var prefix:** every variable above is read as-is **or** with a `CAIRN_` prefix (e.g. `CAIRN_LLM_PROFILE`, `CAIRN_MAX_REPAIR`). Legacy `LEX_`/`LEXBOT_` prefixes still work but print a one-time deprecation warning — prefer `CAIRN_`.
- <a id="role-routing"></a>**Role routing (`LLM_ROUTING`, optional):** layer a cheap **worker** over any profile while keeping the strong **reasoner**. One flag picks where the mechanical steps (identify-elements, generate-code/repair) run:
  - `fast` → worker on **Groq** `llama-3.3-70b-versatile` — lowest latency/cost, OpenAI-compatible tool-calling. ⚠ Groq 400s on large-codegen `json_schema` (`groq-fast-json-schema-bug`) — fine for design, not a codegen escape.
  - `volume` → worker on **OpenRouter** `deepseek/deepseek-chat` — model breadth, but **slow on large codegen** (4.5–13 min, see [Provider latency](#provider-latency)).
  - `volume-fast` → worker on **Anthropic** `claude-sonnet-4-6` — the latency-safe sibling of `volume`: codegen finishes in ~90 s while the cheap `judge` scorer still runs on OpenRouter via `LLM_PROFILE`. **Recommended when OpenRouter codegen overruns timeouts (#110).**
  - default (unset) → the profile's own per-tier models.

  In **every** preset the reasoner (design test cases + Pilot verdict) stays on **Anthropic** `claude-opus-4-8` for judgment quality, and the cheap `judge` scorer keeps the profile tier (routing never touches it). Override any role with `CAIRN_ROLE_WORKER` / `CAIRN_ROLE_REASONER=provider:model`; pass `--routing <preset>` on `explore`/`design`/`automate` to set it per run. Per-run **per-role cost** (tokens + $) is printed in the run summary.
- <a id="provider-latency"></a>**Provider latency & per-step timeout (`STEP_TIMEOUT_MS`, #110):** providers differ by minutes per step. Measured on `https://plune.ai/`: Anthropic `claude-opus-4-8` design ≈ **90 s** (finishes); OpenRouter `deepseek-chat` codegen ≈ **4.5–13 min**; OpenRouter `deepseek-r1` design **overran 4 min without finishing**. Each structured call is bounded by `STEP_TIMEOUT_MS` (default `240000`); on overrun the step fails with an **actionable error** (try a faster `--routing` such as `volume-fast`, or `LLM_PROFILE=anthropic`, or raise `STEP_TIMEOUT_MS`) instead of hanging. `0` disables the timeout. **MCP guidance:** the MCP caller (Claude Code / Cursor) sees a timeout as a clean tool error — keep `STEP_TIMEOUT_MS` at/under your client's tool timeout, and prefer the `volume-fast`/`anthropic` paths for interactive MCP use.
- **Domain knowledge:** put `*.md` files in `./knowledge/` with a `url:` front-matter to inject credentials/validation rules into design.
- **Prompt overrides & house-style:** drop `./prompts/<name>.md` to override any built-in prompt, and use `--style` to load a house-style pack — see [Prompts & styles](prompts-and-styles.md).
