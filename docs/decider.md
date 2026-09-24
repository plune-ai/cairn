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
`--decider laya` for that server.

Cairn never sends knowledge files, session state, screenshots or environment values. On top of that it scrubs,
**best-effort**, the values your knowledge files label as secrets and your secret environment variables
(`*_PASSWORD`, `*_TOKEN`, `*_KEY` except public keys, anything with `SECRET`, …) out of every state and question it
sends. A label counts when it names the secret itself — `Password:`, `Admin password:`, `Stripe key:`, `Пароль
адміністратора:` — not when it talks about one (`Password rules:`, `Правила пароля:`). A secret that nothing labels
cannot be recognised — keep such values out of case texts, or write each alone after its label.

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

## Configuration

All variables, their defaults and their `CAIRN_`-prefixed forms: [configuration.md](configuration.md#decision-layer).
`--decider <off|jev|laya|compat>` on `explore`, `design` and `automate` overrides `DECIDER` for one run.

## Checking the setup

```text
$ DECIDER=laya DECIDER_BASE_URL=http://127.0.0.1:8000 LAYA_API_KEY=<same token> cairn doctor
…
Cairn decision layer (DECIDER — ADR-0022)
  Provider: laya · model: jev-latest
  Base URL: http://127.0.0.1:8000
  Data goes to: this machine (localhost)
  Uses: repair-triage, coverage · min confidence 0.75 · timeout 10000 ms · ≤ 200 decisions/run
  ✓ Test call (noul): 162 ms · answered by laya-rl-agent
```

A configuration mistake or an unreachable server is printed as a `✗` line with the reason.
