# ADR-0022: An optional decision layer (System One: Jev / Laya) — a separate seam, off by default, never trusted

- **Status:** Accepted
- **Date:** 2026-09-24
- **Decision in code:** `src/decider/` (`types.ts`, `capabilities.ts`, `client-http.ts`, `guarded.ts`, `redact.ts`, `index.ts`), `src/config/index.ts` (`parseDeciderConfig`), `src/core/config.ts`, `src/llm/cost.ts`, `src/telemetry/index.ts`, `src/cli/index.ts` (`--decider`, `doctor`), `src/mcp/tools.ts`
- **Applies from:** the next minor after 0.7.0
- **Relationship to prior ADRs:** a new pass under [ADR-0017](0017-opt-in-pipeline-passes.md) (opt-in, byte-identical when off); its answers are untrusted per [ADR-0020](0020-untrusted-llm-verdicts-and-data-protection.md); deliberately **not** a role under [ADR-0011](0011-per-role-model-routing.md); traced per [ADR-0006](0006-observability-langfuse-v5-otel.md); fits the plain pipeline of [ADR-0013](0013-drop-langgraph.md).

## Context

Some of Cairn's steps do not generate anything — they **pick from a finite list**: why did this test fail, does
this case cover that checklist item, which of these elements did the step mean. Today every such pick is either
an LLM call or no decision at all.

A class of models now does exactly this and nothing else. "System One" models answer typed questions about a
state — `noul` (yes/no), `choice` (one of a list), `score` (a position on 2–10 described levels) — and return
probabilities, never text:

- **Jev** (TypeSafe) — a cloud API, `POST /v1/systemone`.
- **Laya** (Convai Innovations) — an open ~421M-parameter model with the same contract, run locally.

The honest expectation is modest. The cost of a run is `designTestCases` (Opus) and `generateCode` (Sonnet); a
decider replaces neither. What it can plausibly buy is fewer wasted repair attempts, a cheaper coverage judge,
and — later — better use of the `--flow` page budget. Whether it does is a question for a pilot, not for this
record. What this record has to settle is how such a component may enter the pipeline without changing it for
anyone who does not ask, and without being believed more than it deserves.

## Decision

**A parallel seam, `src/decider/`, that exists only when the user names a provider — and whose every answer can
only make a result stricter, falls back silently on any failure, and is bounded before it is sent.**

1. **A separate seam, not a role.** `RoleRouter` builds `StructuredInvoke` over LangChain chat models: a prompt
   in, a zod-validated object out. A System One model takes no prompt and returns no object; forcing it into that
   contract would put a fake chat model into the one layer every LLM call goes through. `KNOWN_ROLES` stays
   `worker | reasoner`.
2. **Off by default, and one switch.** `makeDecider(cfg)` returns `undefined` unless `DECIDER` (or `--decider`)
   names `jev`, `laya` or `compat`. There is no other switch: every use point is gated on that value, so a run
   without the flag executes the code it executed before the layer existed. The config key is *absent*, not
   `undefined`. **A key alone enables nothing** — `TYPESAFE_API_KEY` in the environment changes no behaviour.
3. **Every answer is untrusted (ADR-0020) and the asymmetry is the rule.** A decider may make a result stricter,
   never softer: downgrade, never upgrade; exclude, never unblock. Below `DECIDER_MIN_CONFIDENCE` the answer is
   ignored and the current path runs. Safety rules (`guardrails.ts`, the crawler's destructive-link filter) are
   not optional and do not consult it. Each such guard has a test that goes red when the guard is removed.
   **One exception, by design (spec §6.2): coverage.** `checklist_coverage` is a metric, not a gate — nothing
   is blocked or unblocked by it — and there a deciding decider *replaces* the LLM judge's number, which can come
   out higher. Its guard is different: the decider's number stands only when every checklist item is decided —
   some case confidently covers it, or every case confidently does not. An item that no case confidently covers
   and some case is unsure about, an unavailable call or an answer that is not a yes/no hands the whole score back
   to the judge; and the score's comment names its source (`decider (laya): …`), so a reader never mistakes it
   for the judge's.
4. **It never sinks a run.** Every failure — network, timeout, 4xx/5xx, a state over the provider's limit, an
   answer that fails validation — surfaces as one exception, `DeciderUnavailable`; the call site catches it and
   takes the path it would have taken without a decider. The failure is traced, not raised.
5. **Bounded before it is sent.** Caps — the state together with its longest question, one question's own text,
   one option's text, options per choice, questions per call — are checked *before* any request; one timeout covers the whole call;
   exactly one retry on 429/5xx; a per-run ceiling on decisions (`DECIDER_MAX_CALLS`; a retry belongs to its
   decision). Decider calls are not charged to the LLM `CallBudget` — they have their own ceiling.
6. **The data stays where the user put it.**
   - Each provider reads **only its own address and key**: `jev` → the TypeSafe SDK's own pair,
     `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`) + `TYPESAFE_API_KEY` (required); `laya` →
     `DECIDER_BASE_URL` + `LAYA_API_KEY` (the server's own variable); `compat` → `DECIDER_BASE_URL` +
     `DECIDER_API_KEY`. A TypeSafe key is never sent to a laya or compat address — not even one left in `.env`
     when `--decider jev` is tried for a single run. And `jev` accepts only an `https://*.typesafe.ai` address:
     the TypeSafe SDK's variable may point at a laya-serve (this project's own machine does), and `jev` there
     would hand it the TypeSafe key and read it with Jev's caps, which laya cuts silently. For the same reason
     `CAIRN_TYPESAFE_BASE_URL` needs `CAIRN_TYPESAFE_API_KEY`: the bare key belongs to the bare address. A URL
     carrying `user:password` is refused, and an invalid URL is refused without being echoed — a malformed value
     (`https://u:p#ss@host`, a key pasted by mistake) can still carry a credential that no parser finds.
   - The first decider of a process whose base URL is not loopback prints one line saying where the data goes
     and recommending `laya` for apps behind a login; `cairn doctor` prints the destination explicitly.
   - A state never contains knowledge files, `storageState`, screenshots or env values — Cairn never puts them
     there — and every state and question text is additionally **scrubbed**, best-effort, of the values the run's
     knowledge labels as secrets and of secret environment variables, because a designed case can *echo* a
     credential it read in a knowledge file. Option labels are the answer contract and are not rewritten. The
     heuristic is weighed by what a wrong guess costs — a missed secret leaves the machine, a word scrubbed by
     mistake damages every input it appears in: a secret word on a line points at the values after it, and only
     credential-shaped ones are taken; a plain value only under a label whose *head* word names the secret
     ("Password: qwerty", not "Password rules: must contain a digit" nor "Forgot password: /forgot-password");
     a credential-shaped value is replaced
     wherever it appears (a negative case's `Qwerty123!x` carries it), a plain one or a PIN only as a whole token.
     A scrubbing failure is a fallback like any other.
   - A failed request is reported by its error name and cause code, never by its message: `fetch` quotes header
     values and URLs in its messages.
7. **The wire format lives in one file.** `client-http.ts` is the only code that knows Jev's JSON. Cairn's own
   `Question` carries descriptions — a `choice` is `label → description`, a `score` is an ordered list of level
   descriptions, a `noul` has **required** `criteria.true/false` — because descriptions are part of the protocol
   and, measured, decide answer quality (below). A `noul`'s confidence is `|2p − 1|`, computed by Cairn: Jev
   returns none for `noul`, and this is the two-option form of its documented choice statistic. **For `laya`, a
   `noul` goes over the wire as a two-option `choice` built from the same criteria** (reason below).
8. **Cost and tracing.** A successful call is recorded in the run's `CostLedger` under a `decider` role, priced by
   provider (Jev per input token, laya free, compat unknown); the row exists only when a decider was called. Each
   call is a Langfuse span `decider.<use>` under the active stage — provider, model, latency, questions, answers
   with their distributions, `fallback` and its reason — plus a `decider.<use>.confidence` score.
9. **Evidence before defaults.** A use point enters in **shadow mode** first (`--decider-shadow`): the decider is
   asked, its answer is recorded beside the current path's decision in `runs/<id>/decider-shadow.json`
   (`decider-shadow-automate.json` for `automate`, which reuses a design run's folder) and in Langfuse
   (`decider.<use>.agreement`), and *nothing* else in the run changes — its calls are metered into a private
   ledger, so even `report.json`'s cost is untouched. A use point leaves shadow only on pilot evidence (agreement
   ≥ 90 %, or ≥ 85 % hand-labelled precision for repair triage; fallbacks < 10 %). Use points that fail are
   removed from the default `DECIDER_USES`, or deleted.
10. **No artifact-schema bump.** New `report.json` keys appear only under the opt-in flag. Bumping
    `ARTIFACT_SCHEMA_VERSION` would change every run's `report.json` and break rule 2; an existing reader does not
    notice keys that only an opted-in run writes, so ADR-0014's "a reader could notice" is not met.

## Measured facts this rests on (2026-09-24)

The spec behind this work asked for the wire format to be verified, not guessed. It was, and verifying it
changed the design.

- **Wire format** — from the official Python SDK (`typesafe_sdk` 0.7.1, generated models) and
  `docs.typesafe.ai/api`: `choice.criteria` is a `label → description` map (≤ 255), `score.criteria` an ordered
  list of 2–10 level descriptions, `noul.criteria` optional `{true, false}`; answers are `{noul}`,
  `{choice, probabilities, confidence}`, `{score, legend, probabilities, confidence}`; every response carries
  `usage` (so the ledger reads tokens rather than estimating them). Errors: 401, 422, 429, 529.
- **A Jev-compatible Laya server already exists.** `pip install laya` ships `laya-serve` (`POST /v1/systemone`,
  `GET /health`, optional bearer `LAYA_API_KEY`). Cairn documents it and does not ship one.
- **laya 0.3.11, measured on this project's inputs:**
  - context is **512 tokens** for the `english` checkpoint and **1024** for `multilingual`
    (≈ 3.9 characters per token of English, ≈ 2.5 of Ukrainian);
  - an over-long state is **truncated silently** — `usage.input_tokens` stops at the limit and the server still
    answers, from the part it read, wrongly. Its source shows why: each question is encoded on its own as
    `[question + options] [state]`, the question part is cut at 192 tokens (each option at 48), and the state
    gets what is left. Hence Cairn enforces the caps before the request: `laya` and `compat` take at most
    1 200 characters of state + question (under 512 tokens even at 2.5 characters per token), 400 characters
    of question text and 100 characters per option (`label: description`, a criterion, a level) — a 370-character
    criterion measured 79 tokens and was cut to 48;
  - `noul` is **confidently wrong** on some phrasings (p = 0.89–0.94 on the wrong side, even with descriptive
    criteria) — a confident error passes any threshold;
  - the same judgment asked as a two-option `choice` with descriptive criteria errs with **low confidence**
    (0.00–0.15) — which the threshold turns into a fallback. That is why laya gets `noul` as `choice`;
  - bare `Yes`/`No` labels are unreliable in either form, which is why `noul` criteria are required;
  - laya's `choice` confidence is `1 − H(p)/ln n`; Jev documents a different statistic. **Thresholds do not
    transfer between providers** — calibration is per use point and per provider. Note the scale of the numbers
    above: 0.00–0.15 is laya's entropy confidence, while Cairn thresholds a two-option `noul` on `|2p − 1|`
    (0.15 there is about 0.45 here; the default 0.75 is about 0.46 there). The default still turns those errors
    into fallbacks, but these figures are not a calibration.
- **An unknown `model` id on laya auto-routes by detected language**, per its source. So the default model is
  `jev-latest` for every provider; `DECIDER_MODEL=multilingual` pins laya's multilingual checkpoint.
- **Coverage on laya is not ready to act.** Five Ukrainian checklist items × three Ukrainian cases, truth known
  (each of three cases covers one item): with the shipped question the multilingual checkpoint got 2 of 15 right
  and answered **5 wrong at confidence ≥ 0.75** — the case about a wrong password "covered" password recovery
  and log-out at 0.97–0.98, so the score came out 1.00 against a true 0.60. Three other shapes (the item in the
  state, the question in Ukrainian, both) did no better: 3–4 of 15, up to 7 confident errors, or no confident
  answer at all. The English checkpoint was never confident on these texts (every answer a fallback). Repair
  triage on twelve labelled Playwright failures: 5–6 of 12 right, one confident answer — right — so nothing was
  wrongly kept out of repair. Hence an active decider defaults to `repair-triage` alone; shadow mode asks every
  use point, and `coverage` acts only when named in `DECIDER_USES`.
- **Latency on a CPU** (no GPU; the same twelve triage questions, sent together as a failing suite sends them, so
  each waits for the others): the multilingual checkpoint 0.7 s at the median and 1.2 s at p95, the English one
  2.2 s and 3.6 s; one question alone, 0.1 s (multilingual) and 0.3 s (English). An earlier run on the same machine took 3.3 s and 4.6 s,
  and 9.5 s and 13.5 s: the load on the machine and the number of failing tests set the latency more than the
  checkpoint. The default `DECIDER_TIMEOUT_MS` of 10 000 covers every multilingual measurement. On the busier run
  the English checkpoint's slowest calls (13.5 s) would pass it and become fallbacks.

## Consequences

- **A run without the flag is the run it was.** Same prompts, same calls, same files — pinned by tests.
- **The decider is only ever a narrower gate** — coverage aside, where it replaces a metric and says so (rule 3).
  At worst it costs time and fallbacks; it cannot turn a failure into
  a pass, unblock a destructive action, or keep a failing test out of repair without a confident answer.
- **Most small-model answers will be fallbacks at first**, especially on laya's multilingual checkpoint. That is the
  intended failure mode: a fallback is today's behaviour.
- **The protocol has a single owner**, so a Jev wire change is one file and one test file.
- **Configuration grows by twelve variables and two flags** (`--decider`, `--decider-shadow`) — eight `DECIDER*`
  settings, three provider keys and TypeSafe's own `TYPESAFE_BASE_URL` — all `CAIRN_`-prefixable, all inert when
  `DECIDER` is off. `DECIDER_SHADOW` without a provider is an error: a pilot that silently collected nothing is
  worse than a refusal.
  The `--help` snapshot changed on purpose.
- **Confidence is a shape, not a promise.** Documentation never presents it as a probability of being right.
- **Jev stays out of `docs/cost.md` and `npm run bench`** until the repository owner has read TypeSafe's terms on
  publishing performance data. Laya numbers are fine.

## Rejected alternatives

- **A third role in `RoleRouter`.** A different contract (no prompt, no structured output) behind the same seam
  would make every LLM call site carry assumptions that are false for one "model".
- **Enable the layer when `TYPESAFE_API_KEY` is present.** A key is a credential, not a decision; users set it for
  other tools. It would also have moved every such user's run off its baseline without a flag.
- **Replace the LLM judge by default.** Unproven; the pilot decides. The judge stays the fallback and the baseline.
- **Depend on `@typesafe-ai/sdk`.** One `POST` and one response shape do not justify a dependency, and the laya
  quirks (`noul` as `choice`) would have to be patched around it anyway.
- **Clip an over-long state instead of refusing it.** Laya already clips silently and answers from the fragment —
  the very behaviour that produced wrong answers. A refusal is a fallback; a clipped state is a guess.
- **One shared key variable for every provider.** Switching `DECIDER=jev` → `compat` would have sent a cloud key
  to a third-party server.
- **One shared address variable for every provider.** Caught before release: a laya address left in `.env`
  would have received the TypeSafe key the moment `--decider jev` was tried. Keys and addresses
  are paired per provider for the same reason.

## Open questions from the spec, answered

1. *Wire format* — verified, above. 2. *A ready laya server* — `laya-serve`, above. 3. *Decider tokens* — from
`usage`; a length-based estimate only when a server omits it. 4. *`--decider` in the GitHub Action* — not in v1;
env is enough (`action.yml` unchanged). 5. *Publishing Jev results* — the owner's call; nothing is published.
6. *Failure-time page snapshot for `locator-heal`* — to be checked when that use point lands. 7. *POM stability
for deterministic patches* — a `locator-heal` v2 question; v1 only proposes.
