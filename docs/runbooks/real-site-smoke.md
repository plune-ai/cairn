# Runbook: a safe smoke on a REAL application

> **Status:** ✅ verified on `cvc.valtive.io` (behind a Google login). The procedure minimizes the risk to real data.

## Safety (why it's safe)
- **read-only by default:** the design/code do `toBeVisible/toBeEnabled/toBeChecked`, not the consequences of actions.
- **destructive controls** (Delete/Submit/Convert/Log out/Add) → only a VISIBILITY check, without a click.
- **MTC/manual cases** (full generation, security, irreversible actions) → NOT automated (`automate` skips them).
- **expired-session detection:** if there's a redirect to login → a warning, not blind testing.

## Steps
1. **Session:** `npm run session:save -- --url https://app.example.com/ --name myapp` (log in via Chrome, press Enter). The file is in `.auth/` (gitignored — do NOT commit).
2. **(Opt.) Knowledge:** `./knowledge/<name>.md` (frontmatter `url: /path`) — credentials/validation rules.
3. **(Opt.) Checklist:** `.md`/text or `## TC-XX` — steers what to test.
4. **First design (no code — the safest):**
   ```
   cairn design --url https://app.example.com/page --session myapp --checklist plan.md
   ```
   → review `runs/<id>/testcases/ATC-*.md` (+ MTC-* manual).
5. **Then — automate the approved ones:** `cairn automate --run runs/<id> --validate --session myapp`.
   Or the full flow at once: `cairn explore --url ... --session myapp` (code+validation+repair+Pilot).

## Robustness
- **Rate limit / 5xx:** `retryInvoke` auto-retries transient errors (backoff).
- **Expired session:** the warning `⚠ redirect to LOGIN` → re-capture the session.
- **Artifacts:** `runs/<id>/` (gitignored) — `report.md`, `testcases/`, `tests/`, `snapshots/`, `run.log`.
- **Observability:** every run — a Langfuse trace + scores (self-hosted).
- **Cost:** the loops are bounded by `maxRepair`; the token cost is visible in the Langfuse traces.

## Do NOT
- Do NOT commit `.auth/` or `.env` (real tokens).
- Do NOT run `automate --validate` on pages with irreversible actions without being sure the cases are read-only.
