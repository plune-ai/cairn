# Configuration (env)

| Var | Purpose |
|---|---|
| `LLM_PROFILE` | `anthropic` \| `openrouter` \| `mixed` (per-tier default models) |
| `LLM_ROUTING` | per-role preset: `fast` (Groq worker) \| `volume` (OpenRouter worker) — see [Role routing](#role-routing) |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` | provider keys (per profile / routing) |
| `QA_TESTCASE_LANG` | test-case language (default `English`; e.g. `Ukrainian`, `uk`) |
| `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse — **cloud or self-hosted** (optional; see [Langfuse](langfuse.md)) |
| `BROWSER_BACKEND` | `lib` (in-process Playwright) \| `cli` |
| `BROWSER_CHANNEL` | `chrome`/`msedge` → drive a system browser (helps with OAuth; **no bundled-Chromium download**, and coexists with a host project's own Playwright). Per-command flag: `--channel`. |
| `MAX_REPAIR` | repair attempts (default 2) |

- **Env var prefix:** every variable above is read as-is **or** with a `CAIRN_` prefix (e.g. `CAIRN_LLM_PROFILE`, `CAIRN_MAX_REPAIR`). Legacy `LEX_`/`LEXBOT_` prefixes still work but print a one-time deprecation warning — prefer `CAIRN_`.
- <a id="role-routing"></a>**Role routing (`LLM_ROUTING`, optional):** layer a cheap **worker** over any profile while keeping the strong **reasoner**. One flag picks where the mechanical steps (identify-elements, generate-code/repair) run:
  - `fast` → worker on **Groq** `llama-3.3-70b-versatile` — lowest latency/cost, OpenAI-compatible tool-calling.
  - `volume` → worker on **OpenRouter** `deepseek/deepseek-chat` — model breadth.
  - default (unset) → the profile's own per-tier models.

  In **every** preset the reasoner (design test cases + Pilot verdict) stays on **Anthropic** `claude-opus-4-8` for judgment quality, and the cheap `judge` scorer keeps the profile tier (routing never touches it). Override any role with `CAIRN_ROLE_WORKER` / `CAIRN_ROLE_REASONER=provider:model`; pass `--routing <preset>` on `explore`/`design`/`automate` to set it per run. Per-run **per-role cost** (tokens + $) is printed in the run summary.
- **Domain knowledge:** put `*.md` files in `./knowledge/` with a `url:` front-matter to inject credentials/validation rules into design.
- **Prompt overrides & house-style:** drop `./prompts/<name>.md` to override any built-in prompt, and use `--style` to load a house-style pack — see [Prompts & styles](prompts-and-styles.md).
