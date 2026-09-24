# Decision layer (`DECIDER`)

Some of Cairn's steps do not generate anything — they pick from a finite list: *why did this test fail*, *does
this case cover that checklist item*. The decision layer lets a **System One** model answer those picks. Such a
model never writes text; it answers typed questions (`noul` yes/no, `choice`, `score`) with probabilities.

It is **off by default** and changes nothing until you name a provider. Design decisions and the measurements
behind them: [ADR-0022](adr/0022-optional-decision-layer.md).

## What it does — and does not do

- It **never** writes cases, code or repairs, and never gives the Pilot verdict. Those stay on the LLM.
- Its answers are **untrusted input**. It can make a result stricter (keep an app bug out of repair), never
  softer; below `DECIDER_MIN_CONFIDENCE` its answer is ignored and Cairn does what it always did.
- It **never sinks a run**. Timeout, server error, an input too long for the model, an invalid answer — each is
  a silent fallback to the current behaviour, recorded in the trace.
- `confidence` describes the shape of an answer's distribution, **not** the chance that it is right. Each
  provider computes it differently, so a threshold tuned on one does not carry over to another.

## Use points

`DECIDER_USES` picks them. By default an active decider consults `repair-triage` alone, and shadow mode asks both
— a use point acts only on evidence, and `coverage` has none yet: on laya's multilingual checkpoint it answered
confidently wrong ([ADR-0022](adr/0022-optional-decision-layer.md#measured-facts-this-rests-on-2026-09-24)). Name
it to turn it on: `DECIDER_USES=repair-triage,coverage`. An unknown name is an error, not a silent no-op. A run in
which none of the enabled use points can fire — `design` without `--checklist`, `automate` without `--validate`,
`MAX_REPAIR=0` — does not start the layer at all: no data notice, no report key, no `decider-shadow.json`.

| Use | Where | What a confident answer does | Otherwise |
|---|---|---|---|
| `repair-triage` | the validate ⇄ repair loop (`explore`, `automate --validate`) | one six-way choice per failing test, over its name and error: `app-bug` / `env-or-session` keep the test **out of the repair hint** and list it under *Not repaired*; `locator-ambiguous` / `locator-missing` / `timing` / `wrong-assertion` only tag its hint line | the test goes into the hint exactly as today |
| `coverage` | the `checklist_coverage` score (`explore`, `design` with `--checklist`) | one yes/no per checklist item per case: covered when some case confidently says yes, uncovered when every case confidently says no. Its number **replaces** the judge's, and the score's comment says so (`decider (laya): …`) | an item no case confidently covers and some case is unsure about, or an unavailable call → the LLM judge decides, as today |

When every failing test is excluded, the loop stops without spending a repair attempt. An exclusion holds while
the test fails the same way: every repair regenerates the suite, so a test that then passes is not listed as
*Not repaired*, and one that fails with a different error is asked about again.

## Providers

| | `jev` | `laya` | `compat` |
|---|---|---|---|
| What | TypeSafe's cloud API | Convai's open model, on your machine | any other server speaking Jev's `POST /v1/systemone` |
| Data goes to | TypeSafe (`api.typesafe.ai`) | this machine | wherever `DECIDER_BASE_URL` points |
| Address | `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`; only an `https://*.typesafe.ai` address) | `DECIDER_BASE_URL` (required) | `DECIDER_BASE_URL` (required) |
| Key | `TYPESAFE_API_KEY` (required) | `LAYA_API_KEY` (if the server wants one) | `DECIDER_API_KEY` (optional) |
| Input Cairn sends at most | 60 000 characters: the state + one question | 1 200 characters: the state + one question (a question alone ≤ 400, one answer option ≤ 100) | as laya |

**Where the data goes matters.** With `jev`, fragments of the page's accessibility tree, the text of test cases
and the error messages of failing tests leave your machine. For an application behind a login, prefer `laya`.
Cairn prints one line when a decider's data leaves the machine, and `cairn doctor` spells out the destination.
Each provider reads only its own address and key, so switching `--decider laya` to `--decider jev` never sends
your TypeSafe key to the laya address in your `.env`. And `jev` talks to TypeSafe only: if your `TYPESAFE_BASE_URL`
points at a laya-serve (the TypeSafe SDK can be set up that way), `--decider jev` stops with an error — use
`--decider laya` for that server. To reach TypeSafe from such a machine, set `CAIRN_TYPESAFE_BASE_URL` and
`CAIRN_TYPESAFE_API_KEY` together: the `CAIRN_` names win, and the address without its key is an error, so the
local token of the SDK setup never travels to TypeSafe.

Cairn never sends knowledge files, session state, screenshots or environment values. On top of that it scrubs,
**best-effort**, the values your knowledge files label as secrets and your secret environment variables
(`*_PASSWORD`, `*_TOKEN`, `*_KEY` except public keys, anything with `SECRET`, …) out of every state and question it
sends. A secret word on a line (`Password`, `API key`, `Token`, `Пароль`, …, also in a table header) points at the
values after it, and those that look like credentials are taken — `Qwerty123!`, `sk_live_…`, `admin@acme.test`,
never a plain word; so is the credential in a login pair such as `qa@acme.test / Qwerty123!`. A label that names
the secret itself also takes a plain value: `Password: qwerty`, `Login / password: admin / qwerty`, `PIN: 4711`,
and so does a table row such as `| Password | qwerty |`. Its value is in the column named for one (`Value`,
`Test data`, `Тестове значення` — not `Default value` or `Data source`), or else in the first column that neither
describes the field (`Type`, `Role`, `Format`, `Status`, `Result`, `Min`) nor holds a flag (`yes`, `✓`, `required`);
the columns past it hold results or translations and are never taken. A matrix gives one value per column: its first
header cell is empty or names an environment, account or role, or its columns are environments —
`| Parameter | Staging | Production |`, `| QA1 | QA2 |`. A word that names a type (`password`, `textbox`) is never a
value — in a table, after a label or in an environment variable (`DB_PASSWORD=password`): a password `password`
protects nothing. A label that only talks about one takes no plain value: `Password rules: must contain a
digit`, `Forgot password: /forgot-password` (a page path or a URL is never taken), `Empty password: "Password is
required"`; nor does a quoted UI text (`"Forgot password?"`). A credential-shaped value is replaced wherever it
appears, so `Qwerty123!x` in a negative case loses it too; a plain value or a PIN only as a whole token, never
inside a longer word. A secret that nothing labels cannot be recognised — keep such values out of case texts.

## Running Laya locally

Laya ships its own Jev-compatible server:

```bash
pip install laya
LAYA_API_KEY=<a token you choose> LAYA_HOST=127.0.0.1 laya-serve   # port 8000 by default (LAYA_PORT); LAYA_HOST defaults to 0.0.0.0
curl http://127.0.0.1:8000/health                                   # {"status":"ok","loaded":["multilingual","english"],…}
```

Then:

```bash
DECIDER=laya DECIDER_BASE_URL=http://127.0.0.1:8000 LAYA_API_KEY=<same token> cairn doctor
```

Cairn never starts Laya or downloads its weights. Laya picks a checkpoint by the language of the text unless you
pin one: for an application whose texts are not English, set `DECIDER_MODEL=multilingual`. Laya's context is
short: it reads each question together with the state, cuts each answer option at 48 tokens, the question part
at 192 and the whole at 512 (English checkpoint) or 1 024 (multilingual) — silently, answering from what it read.
So Cairn counts the state and the question together, checks every option on its own, and refuses what would not
fit: a longer input is a fallback, never a truncation.

## Shadow mode — judge it before you trust it

```bash
cairn explore --url <url> --checklist checklist.md --decider laya --decider-shadow
```

In shadow mode the decider is asked at every enabled use point, and **nothing it says is acted on**: the run's
prompts, tests, `report.json` (cost included — its calls go to a private ledger) and `report.md` are what they
would have been without it. Its answers land in `runs/<id>/decider-shadow.json` (`decider-shadow-automate.json`
for `automate`, which reuses a design run's folder) next to what the run actually did:

```json
{ "provider": "laya", "model": "jev-latest", "minConfidence": 0.75, "calls": 3, "fallbacks": [], "cost": { … },
  "entries": [
    { "use": "repair-triage", "input": "Playwright test \"…\" failed.\nError:\n…", "current": "repair",
      "decider": { "category": "timing", "confidence": 0.82, "wouldExclude": false }, "confidence": 0.82, "latencyMs": 164 },
    { "use": "coverage", "input": { "items": ["…"], "cases": ["…"] }, "current": { "value": 0.8, "source": "judge" },
      "decider": { "value": 0.8, "comment": "uncovered: …", "perItem": [{ "item": "…", "covered": true }],
                   "asked": [{ "case": 0, "item": 0, "yes": true, "confidence": 0.91 }] },
      "latencyMs": 1210, "agreement": 1 } ] }
```

`asked` keeps every (case, item) answer with its confidence — in shadow mode the whole matrix, nothing pruned —
which is what a per-use threshold is tuned on. Every text in
the file is scrubbed exactly like the input that was sent. `agreement` (also a Langfuse score,
`decider.<use>.agreement`) is 1 when the decider's coverage is within 0.1 of the LLM judge's; it is absent when
the judge failed and the token-overlap fallback scored the run, and absent for repair triage: today's path does
not classify failures, so its answers must be checked by hand. A use point is worth turning on when the pilot shows agreement ≥ 90 % (hand-checked precision ≥ 85 % for
triage) with fewer than 10 % fallbacks — and the confidence threshold is tuned per use point and per provider.

## Configuration

All variables, their defaults and their `CAIRN_`-prefixed forms: [configuration.md](configuration.md#decision-layer).
`--decider <off|jev|laya|compat>` on `explore`, `design` and `automate` overrides `DECIDER` for one run;
`--decider-shadow` turns shadow mode on for one run.

## Checking the setup

```text
$ DECIDER=laya DECIDER_BASE_URL=http://127.0.0.1:8000 LAYA_API_KEY=<same token> cairn doctor
…
Cairn decision layer (DECIDER — ADR-0022)
  Provider: laya · model: jev-latest
  Base URL: http://127.0.0.1:8000
  Data goes to: this machine (localhost)
  Uses: repair-triage · min confidence 0.75 · timeout 10000 ms · ≤ 200 decisions/run
  ✓ Test call (noul): 162 ms · answered by laya-rl-agent
```

A configuration mistake or an unreachable server is printed as a `✗` line with the reason.
