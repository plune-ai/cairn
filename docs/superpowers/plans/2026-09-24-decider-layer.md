# Optional Decision Layer (decider: Jev / Laya) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user opt into a System One "decider" (TypeSafe Jev, Convai Laya, or any Jev-compatible server) at the points where Cairn picks from a finite list — without changing a single byte for anyone who does not opt in.

**Architecture:** A parallel seam `src/decider/` beside `RoleRouter` (Jev/Laya are not chat models). `makeDecider(cfg)` returns `undefined` unless `DECIDER` names a provider; every use point is gated on its own optional dependency, so a run without the flag takes exactly today's code path. A decider answer is untrusted input (ADR-0020): it can only make a result stricter, any failure falls back silently to the current behavior, and every call is bounded (timeout, one retry, per-run ceiling, provider caps checked before the request).

**Tech Stack:** Node ≥ 20 (global `fetch`), TypeScript strict (NodeNext, `noUncheckedIndexedAccess`), zod 4, vitest 5, commander 15, Langfuse v5 (optional peer, lazy). No new dependency — the official `@typesafe-ai/sdk` is deliberately not added: one `POST` does not justify a dependency.

**Spec:** `../../../../cairn-decider-task.md` (umbrella root, Ukrainian) — sections referenced below as §N.

---

## Scope of this plan

| PR | Content | Status in this plan |
|---|---|---|
| 1 | skeleton: `src/decider/*`, config, `doctor`, ledger, telemetry, ADR-0022, client/config tests | Tasks 1–7 |
| 2 | `--decider-shadow`, `repair-triage`, `coverage`, byte-identical + dead-decider integration tests | Tasks 8–12 |
| 3 | Laya: server, docs, verification on the multilingual checkpoint with `QA_TESTCASE_LANG=Ukrainian` | Task 13 |
| 4 | `locator-heal` v1 (a verified proposal in the repair hint) | Tasks 14–17 |
| 5, 6 | `judge`, `crawl-rank`, `atc-mtc`; phase 3 | **Out of scope.** The spec gates PR 5 on "the first shadow data" and PR 6 on "the pilot showed sense" (§12). That data is 20–30 real shadow runs on 3+ apps (§9) and cannot be produced by writing code. |

## Facts established before planning (primary sources, 2026-09-24)

These replace the spec's guesses (§5.2 said "verify, don't guess"; §13 lists them as open questions).

1. **Wire format** — from the official Python SDK `typesafe_sdk` 0.7.1 (generated models) and `docs.typesafe.ai/api.md`:
   - request `{ state, model, questions: { <id>: Question } }`, `model` required (`jev-latest`);
   - `noul`: `{ type, instructions, criteria?: { true, false } }` → answer `{ type: "noul", noul: p }` — **no `confidence`**;
   - `choice`: `{ type, instructions, criteria: { <label>: description | null } }` (≤ 255) → `{ type, choice, probabilities: { <label>: p }, confidence }`;
   - `score`: `{ type, instructions, criteria: [ <level description>, … ] }` (2–10, index = score) → `{ type, score (expected value), legend, probabilities: { "0": p, … }, confidence }`;
   - response `{ model, answers, usage: { input_tokens, output_tokens } }`; errors 401/422/429/529.
   - ⇒ the spec's `options: string[]` / `levels: number` become `options: Record<label, description>` / `levels: string[]` — descriptions are part of the protocol, and (fact 4) they decide the answer quality.
2. **A Jev-compatible Laya server exists**: `pip install laya` ships `laya-serve` (`POST /v1/systemone`, `GET /health`, bearer via `LAYA_API_KEY`, localhost with `LAYA_HOST`). Verified live on this machine. No `examples/laya-server/` is needed (§5.4: "if one exists and works — document it").
3. **Usage is reported** by both Jev and laya → the ledger takes tokens from `usage`, estimating only when absent (§13.3).
4. **Measured on laya 0.3.11** (probes: `probe-laya*.mjs` in the session scratchpad; numbers copied here):
   - context: `english` checkpoint **512** tokens, `multilingual` **1024**; ~3.9 chars/token English, ~2.5 Ukrainian;
   - an over-long state is **truncated silently** (`input_tokens: 1024`, answer still returned — and wrong);
   - `noul` answers are **confidently wrong** on some phrasings (p = 0.89–0.94 on the wrong side, 2/8 with descriptive criteria, worse without);
   - the same judgment as a two-option `choice` with descriptive criteria errs with **low confidence** (0.00–0.15) — which a confidence threshold turns into a fallback;
   - laya's `choice` confidence is `1 − H(p)/ln n`; Jev documents a different statistic ⇒ thresholds do not transfer between providers (§9.5 already expects per-use calibration).
5. **Unknown `model` on laya auto-routes by detected language** (`jev-latest` → `english` for Latin text), per its own source.

## Global Constraints

Copied from the spec; every task's requirements implicitly include these.

- **Default OFF.** Without explicit enablement a run is **byte-identical**: same artifacts, same prompts, same LLM calls (§3.1).
- **A key does not enable the feature.** `TYPESAFE_API_KEY` alone changes nothing; `CAIRN_DECIDER=…`/`DECIDER=…` or `--decider …` is required (§3.2).
- **The decider never sinks a run.** Any error (network, timeout, 4xx/5xx, input over the limit, invalid answer) → silent fallback to the current behavior of that step + a log/trace record (§3.3).
- **Asymmetry** (ADR-0020): a decider may only make a result stricter/safer; below the confidence threshold → current behavior (§3.4).
- **Safety rules are not optional**: `src/safety/guardrails.ts` and the destructive-link filter in `src/flow/crawl.ts` work identically with and without a decider (§3.5).
- **Every use is bounded**: `DECIDER_MAX_CALLS` (default `200`), `DECIDER_TIMEOUT_MS` (default `10000`) (§3.6).
- **Never in `state`**: `./knowledge/*.md` content, `storageState`/cookies, screenshots, env values (§3.7).
- Config defaults (§4): `DECIDER=off`; `DECIDER_BASE_URL` jev → `https://api.typesafe.ai`, laya/compat → required; `DECIDER_USES=repair-triage,coverage`; `DECIDER_MIN_CONFIDENCE=0.75`; `DECIDER_SHADOW=0`. Every variable also reads with the `CAIRN_` prefix.
- Flags `--decider <off|jev|laya|compat>` and `--decider-shadow` on `explore`, `design`, `automate`; **a flag overrides env** (§4).
- `DECIDER=jev` without a key, and `laya`/`compat` without `DECIDER_BASE_URL`, fail **at start** with a clear message (§4).
- Decider calls are **not** charged to the LLM `CallBudget` (§5.5). The `decider` row appears in the per-role cost **only when the decider is on** (§5.5).
- Jev is **not** added to `docs/cost.md` or `npm run bench` (§8.3). `confidence` is never presented as a probability of being right (§8.4).
- Generated specs stay pure `@playwright/test` — no Cairn runtime helpers (§2).
- Repo conventions: English code/docs/commits; no AI attribution anywhere; `docs/adr/README.md` count updated with the new ADR; CLI `--help` snapshot updated deliberately (ADR-0017).

## Decisions this plan takes (to be recorded in ADR-0022)

- **Keys are per provider, never shared:** `jev` → `TYPESAFE_API_KEY` (required); `laya` → `LAYA_API_KEY` (optional; the server's own variable); `compat` → `DECIDER_API_KEY` (optional). A TypeSafe cloud key is never sent to a laya/compat server by accident.
- **Default model `jev-latest` for every provider.** Jev's protocol default; laya treats an unknown id as "auto-route by language" (fact 5). `DECIDER_MODEL=multilingual` pins laya's multilingual checkpoint.
- **`noul` goes over the wire as `choice {a: criteria.true, b: criteria.false}` for `laya`** (fact 4); `criteria` is therefore **required** on every `noul` Cairn asks. `compat` speaks plain Jev.
- **`noul` confidence = `|2p − 1|`**, computed by Cairn for every provider (Jev returns none; it is the two-option form of the documented choice statistic).
- **Caps**: `jev` `{ maxStateChars: 60000, maxOptions: 255, maxQuestionsPerCall: 64 }`; `laya` and `compat` `{ 1200, 20, 16 }` (compat is an unknown server — conservative caps only cost fallbacks).
- **Unimplemented `DECIDER_USES` names are an error**, not a silent no-op (a typo must not look like an enabled feature). `locator-heal` without `repair-triage` is an error (§6.6 step 1).
- **`DECIDER_SHADOW` without a provider is an error** (a pilot that silently collected nothing is worse than a refusal).
- **Artifact schema version is not bumped:** new `report.json` keys appear only under the opt-in flag. A bump would change every run's `report.json` and break §3.1; readers that do not know the keys are unaffected (ADR-0014's "a reader could notice" is not met for an existing reader).
- **Secrets are scrubbed from every state** (`redact.ts`): Cairn never *puts* knowledge/env into a state, but a designed case can *echo* a credential it read in knowledge.
- **GitHub Action (§13.4):** env only in v1 (`action.yml` untouched).

## Review Focus

The five input classes most likely to bite a user that the spec implies but no happy-path test exercises. Each has a pinning test in the owning task.

1. `CAIRN_DECIDER=jev` in the shell and `--decider off` on the command line → the flag must win, but `createEnvReader` reads `CAIRN_*` **before** the bare name, so setting `DECIDER` from the flag would lose. → Task 4, test "flag beats CAIRN_DECIDER".
2. A long ARIA fragment or error sent to laya → the server truncates silently and answers wrong. → Task 1, caps refuse before any `fetch`.
3. The timeout fires while the request is still in flight; the request rejects later → an unhandled rejection crashes Node 20. → Task 3, test "late rejection after timeout is swallowed".
4. A case step echoing a knowledge password (`type Sup3rS3cret! into Password`) → must not reach Jev. → Task 5, redaction test.
5. A decider answer naming a label that was never offered (prompt injection / server bug) → must be rejected, not acted on. → Task 2, "choice outside the options → DeciderUnavailable".

---

# PR 1 — skeleton (branch `feat/decider-skeleton`)

### Task 1: Contract types and provider caps

**Files:**
- Create: `src/decider/types.ts`
- Create: `src/decider/capabilities.ts`
- Test: `tests/unit/decider-caps.test.ts`

**Interfaces:**
- Produces: `Question`, `Answer`, `Decider`, `DeciderCaps`, `DeciderConfig`, `DeciderProvider`, `DeciderUse`, `DECIDER_PROVIDERS`, `DECIDER_USES`, `DeciderUnavailable(message, status?)`; `CAPS`, `checkCaps(caps, state, questions): void` (throws).

- [ ] **Step 1: Write the failing test** — `tests/unit/decider-caps.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { CAPS, checkCaps } from "../../src/decider/capabilities.js";
import { DeciderUnavailable, type Question } from "../../src/decider/types.js";

const yesNo: Question = { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } };

describe("checkCaps — refuse what a provider cannot answer faithfully, before any request", () => {
  it("laya: a state over 1200 chars is refused (laya would truncate it silently)", () => {
    expect(() => checkCaps(CAPS.laya, "x".repeat(1201), { q: yesNo })).toThrow(DeciderUnavailable);
    expect(() => checkCaps(CAPS.laya, "x".repeat(1200), { q: yesNo })).not.toThrow();
  });
  it("jev: 60k chars pass, more is refused", () => {
    expect(() => checkCaps(CAPS.jev, "x".repeat(60_000), { q: yesNo })).not.toThrow();
    expect(() => checkCaps(CAPS.jev, "x".repeat(60_001), { q: yesNo })).toThrow(DeciderUnavailable);
  });
  it("a choice with more options than the provider takes is refused", () => {
    const options = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, null]));
    expect(() => checkCaps(CAPS.laya, "s", { q: { type: "choice", instructions: "pick", options } })).toThrow(/options/);
    expect(() => checkCaps(CAPS.jev, "s", { q: { type: "choice", instructions: "pick", options } })).not.toThrow();
  });
  it("a choice needs at least two options; a score 2..10 levels", () => {
    expect(() => checkCaps(CAPS.jev, "s", { q: { type: "choice", instructions: "pick", options: { only: null } } })).toThrow();
    expect(() => checkCaps(CAPS.jev, "s", { q: { type: "score", instructions: "rate", levels: ["low"] } })).toThrow();
    expect(() => checkCaps(CAPS.jev, "s", { q: { type: "score", instructions: "rate", levels: Array(11).fill("l") } })).toThrow();
  });
  it("too many questions per call, or none, is refused", () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, yesNo]));
    expect(() => checkCaps(CAPS.laya, "s", many)).toThrow(/questions/);
    expect(() => checkCaps(CAPS.laya, "s", {})).toThrow(/no questions/);
  });
  it("compat gets laya's conservative caps (unknown server) and no price", () => {
    expect(CAPS.compat).toMatchObject({ maxStateChars: 1200, maxOptions: 20, maxQuestionsPerCall: 16 });
    expect(CAPS.compat.price).toBeUndefined();
    expect(CAPS.laya.price).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module …/decider/capabilities.js`)

Run: `npx vitest run tests/unit/decider-caps.test.ts`

- [ ] **Step 3: Implement** `src/decider/types.ts`

```ts
/**
 * The decision layer's contract (ADR-0022). A System One model — TypeSafe Jev, Convai Laya, or any
 * server speaking Jev's `POST /v1/systemone` — answers typed questions about a state; it never writes
 * text. These are Cairn's own types: the wire format differs on purpose, and `client-http.ts` is the
 * only place that knows it.
 */
export const DECIDER_PROVIDERS = ["jev", "laya", "compat"] as const;
export type DeciderProvider = (typeof DECIDER_PROVIDERS)[number];

/** Use points this version implements. `DECIDER_USES` accepts nothing else (a typo must not look enabled). */
export const DECIDER_USES = ["repair-triage", "coverage"] as const;
export type DeciderUse = (typeof DECIDER_USES)[number];

export type Question =
  | {
      type: "noul";
      instructions: string;
      /**
       * What a yes and a no mean. Required: measured on laya 0.3.11, a bare yes/no is answered against
       * the text, and these descriptions are what laya's two-option form is asked with (client-http.ts).
       */
      criteria: { true: string; false: string };
    }
  | {
      type: "choice";
      instructions: string;
      /** label → when it applies (null = the label speaks for itself). The answer is one of these labels. */
      options: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      /** Ordered level descriptions; the answer's value is a position between 0 and levels.length − 1. */
      levels: string[];
    };

/**
 * `confidence` describes the SHAPE of the answer's distribution, not the chance it is right, and each
 * provider computes it differently — thresholds are calibrated per use and per provider (spec §8.4, §9.5).
 */
export type Answer =
  | { type: "noul"; value: boolean; p: number; confidence: number }
  | { type: "choice"; value: string; dist: Record<string, number>; confidence: number }
  | { type: "score"; value: number; dist: number[]; confidence: number };

export interface DeciderCaps {
  maxStateChars: number;
  maxOptions: number;
  maxQuestionsPerCall: number;
  /** USD per 1M tokens; undefined → unknown, the cost line shows n/a. */
  price?: { inputPer1M: number; outputPer1M: number };
}

/** Parsed `DECIDER*` configuration (config/index.ts). Absent from AppConfig unless a provider is chosen. */
export interface DeciderConfig {
  provider: DeciderProvider;
  baseUrl: string;
  model: string;
  /** jev: TYPESAFE_API_KEY · laya: LAYA_API_KEY · compat: DECIDER_API_KEY — never another provider's key. */
  apiKey?: string;
  uses: DeciderUse[];
  minConfidence: number;
  timeoutMs: number;
  maxCalls: number;
}

export interface Decider {
  readonly provider: DeciderProvider;
  readonly model: string;
  readonly caps: DeciderCaps;
  readonly uses: ReadonlySet<DeciderUse>;
  readonly minConfidence: number;
  /** The questions are independent: they share `state` and never see each other's answers. */
  decide<K extends string>(use: DeciderUse, state: string, questions: Record<K, Question>): Promise<Record<K, Answer>>;
}

/** Any failure or limit. The call site catches it and takes the path it would have taken without a decider. */
export class DeciderUnavailable extends Error {
  constructor(
    message: string,
    /** HTTP status when the server answered with an error — lets the guard retry 429/5xx once. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeciderUnavailable";
  }
}
```

- [ ] **Step 4: Implement** `src/decider/capabilities.ts`

```ts
import { DeciderUnavailable, type DeciderCaps, type DeciderProvider, type Question } from "./types.js";

/**
 * What each provider can answer faithfully (ADR-0022). Measured for laya 0.3.11 rather than taken
 * from its model card: the `english` checkpoint reads 512 tokens, `multilingual` 1024 (~3.9 chars per
 * token for English, ~2.5 for Ukrainian), and an over-long state is TRUNCATED SILENTLY — the server still
 * answers, from the part it read. So the cap is enforced here, before the request, never by the server.
 * `compat` is an unknown server: it gets laya's conservative caps (a small cap only costs fallbacks).
 */
export const CAPS: Record<DeciderProvider, DeciderCaps> = {
  // Jev: 32k tokens for state + the longest question (docs.typesafe.ai/models) — 60k chars stays inside.
  jev: { maxStateChars: 60_000, maxOptions: 255, maxQuestionsPerCall: 64, price: { inputPer1M: 0.042, outputPer1M: 0 } },
  // ponytail: one cap for both laya checkpoints (the 512-token english one binds); split per checkpoint if the pilot needs room.
  laya: { maxStateChars: 1_200, maxOptions: 20, maxQuestionsPerCall: 16, price: { inputPer1M: 0, outputPer1M: 0 } },
  compat: { maxStateChars: 1_200, maxOptions: 20, maxQuestionsPerCall: 16 },
};

/** Throws DeciderUnavailable for a request the provider cannot answer faithfully — before any network call. */
export function checkCaps(caps: DeciderCaps, state: string, questions: Record<string, Question>): void {
  const n = Object.keys(questions).length;
  if (n === 0) throw new DeciderUnavailable("no questions");
  if (n > caps.maxQuestionsPerCall) throw new DeciderUnavailable(`${n} questions > ${caps.maxQuestionsPerCall} per call`);
  if (state.length > caps.maxStateChars) {
    throw new DeciderUnavailable(`state is ${state.length} chars > ${caps.maxStateChars}`);
  }
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const k = Object.keys(q.options).length;
      if (k < 2 || k > caps.maxOptions) throw new DeciderUnavailable(`question '${key}': ${k} options (allowed 2..${caps.maxOptions})`);
    } else if (q.type === "score" && (q.levels.length < 2 || q.levels.length > 10)) {
      throw new DeciderUnavailable(`question '${key}': ${q.levels.length} levels (allowed 2..10)`);
    }
  }
}
```

- [ ] **Step 5: Run — expect PASS.** `npx vitest run tests/unit/decider-caps.test.ts`
- [ ] **Step 6: Commit** `feat(decider): contract types and measured provider caps (ADR-0022)`

### Task 2: HTTP client — wire ↔ Answer

**Files:**
- Create: `src/decider/client-http.ts`
- Test: `tests/unit/decider-client.test.ts`

**Interfaces:**
- Consumes: `Question`, `Answer`, `DeciderProvider`, `DeciderUnavailable` (Task 1).
- Produces: `HttpTarget { provider; baseUrl; model; apiKey? }`, `postSystemOne<K>(target, state, questions, signal, fetchFn?) → Promise<{ answers: Record<K, Answer>; usage?: { inputTokens; outputTokens }; model?: string }>`, `noulConfidence(p)`.

- [ ] **Step 1: Write the failing test** — `tests/unit/decider-client.test.ts` (mapping part; guard tests join in Task 3)

```ts
import { describe, it, expect, vi } from "vitest";
import { postSystemOne, noulConfidence, type HttpTarget } from "../../src/decider/client-http.js";
import { DeciderUnavailable, type Question } from "../../src/decider/types.js";

const jev: HttpTarget = { provider: "jev", baseUrl: "https://api.typesafe.ai/", model: "jev-latest", apiKey: "k-jev" };
const laya: HttpTarget = { provider: "laya", baseUrl: "http://127.0.0.1:8000", model: "jev-latest" };
const signal = new AbortController().signal;

/** A fetch that records the request and answers with `body` (status 200 unless given). */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const noul: Question = { type: "noul", instructions: "Destructive?", criteria: { true: "Cannot be undone", false: "Harmless" } };
const choice: Question = { type: "choice", instructions: "Why?", options: { "locator-missing": "no element", timing: "too slow" } };
const score: Question = { type: "score", instructions: "Relevant?", levels: ["no", "somewhat", "yes"] };

describe("postSystemOne — request", () => {
  it("POSTs Jev's wire format: criteria map for choice, ordered criteria for score, noul with criteria", async () => {
    const f = fakeFetch({ model: "jev-1.13.0", answers: {
      n: { type: "noul", noul: 0.9 },
      c: { type: "choice", choice: "timing", probabilities: { "locator-missing": 0.2, timing: 0.8 }, confidence: 0.6 },
      s: { type: "score", score: 1.7, legend: { "0": "no", "1": "somewhat", "2": "yes" }, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 }, confidence: 0.7 },
    }, usage: { input_tokens: 120, output_tokens: 9 } });
    await postSystemOne(jev, "S", { n: noul, c: choice, s: score }, signal, f.fn);
    expect(f.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k-jev");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      state: "S",
      model: "jev-latest",
      questions: {
        n: { type: "noul", instructions: "Destructive?", criteria: { true: "Cannot be undone", false: "Harmless" } },
        c: { type: "choice", instructions: "Why?", criteria: { "locator-missing": "no element", timing: "too slow" } },
        s: { type: "score", instructions: "Relevant?", criteria: ["no", "somewhat", "yes"] },
      },
    });
  });
  it("no key → no authorization header", async () => {
    const f = fakeFetch({ answers: { n: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 } } });
    await postSystemOne(laya, "S", { n: noul }, signal, f.fn);
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });
  it("laya: a noul goes over the wire as choice {a: criteria.true, b: criteria.false}", async () => {
    const f = fakeFetch({ answers: { n: { type: "choice", choice: "a", probabilities: { a: 0.94, b: 0.06 }, confidence: 0.67 } } });
    const r = await postSystemOne(laya, "S", { n: noul }, signal, f.fn);
    expect(JSON.parse(String(f.calls[0]!.init.body)).questions.n).toEqual({
      type: "choice", instructions: "Destructive?", criteria: { a: "Cannot be undone", b: "Harmless" },
    });
    expect(r.answers.n).toEqual({ type: "noul", value: true, p: 0.94, confidence: noulConfidence(0.94) });
  });
});

describe("postSystemOne — response mapping", () => {
  it("maps the three answer types and usage", async () => {
    const f = fakeFetch({ model: "jev-1.13.0", answers: {
      n: { type: "noul", noul: 0.2 },
      c: { type: "choice", choice: "timing", probabilities: { "locator-missing": 0.2, timing: 0.8 }, confidence: 0.6 },
      s: { type: "score", score: 1.7, legend: {}, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 }, confidence: 0.7 },
    }, usage: { input_tokens: 120, output_tokens: 9 } });
    const r = await postSystemOne(jev, "S", { n: noul, c: choice, s: score }, signal, f.fn);
    expect(r.answers.n).toEqual({ type: "noul", value: false, p: 0.2, confidence: noulConfidence(0.2) });
    expect(r.answers.c).toEqual({ type: "choice", value: "timing", dist: { "locator-missing": 0.2, timing: 0.8 }, confidence: 0.6 });
    expect(r.answers.s).toEqual({ type: "score", value: 1.7, dist: [0.1, 0.1, 0.8], confidence: 0.7 });
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 9 });
    expect(r.model).toBe("jev-1.13.0");
  });
  it("noul confidence is |2p − 1|: 0 at a coin flip, 1 at certainty", () => {
    expect(noulConfidence(0.5)).toBe(0);
    expect(noulConfidence(1)).toBe(1);
    expect(noulConfidence(0)).toBe(1);
    expect(noulConfidence(0.875)).toBeCloseTo(0.75);
  });
  it.each([
    ["a choice outside the offered options", { c: { type: "choice", choice: "app-bug", probabilities: { "app-bug": 1 }, confidence: 1 } }, { c: choice }],
    ["a missing answer", {}, { c: choice }],
    ["a type that does not match the question", { c: { type: "noul", noul: 0.9 } }, { c: choice }],
    ["a probability outside 0..1", { n: { type: "noul", noul: 1.5 } }, { n: noul }],
    ["a score outside the levels", { s: { type: "score", score: 7, probabilities: {}, confidence: 0.9 } }, { s: score }],
  ])("rejects %s → DeciderUnavailable (an untrusted answer is never acted on)", async (_l, answers, qs) => {
    const f = fakeFetch({ answers });
    await expect(postSystemOne(jev, "S", qs as Record<string, Question>, signal, f.fn)).rejects.toBeInstanceOf(DeciderUnavailable);
  });
  it("HTTP error → DeciderUnavailable carrying the status; body not JSON → unavailable", async () => {
    const e = await postSystemOne(jev, "S", { n: noul }, signal, fakeFetch({ detail: "x" }, 503).fn).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeciderUnavailable);
    expect((e as DeciderUnavailable).status).toBe(503);
    const html = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(postSystemOne(jev, "S", { n: noul }, signal, html)).rejects.toBeInstanceOf(DeciderUnavailable);
  });
  it("network failure → DeciderUnavailable without a status (not retried)", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const e = await postSystemOne(jev, "S", { n: noul }, signal, down).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeciderUnavailable);
    expect((e as DeciderUnavailable).status).toBeUndefined();
  });
  it("never puts the API key into an error message", async () => {
    const e = await postSystemOne(jev, "S", { n: noul }, signal, fakeFetch({}, 401).fn).catch((x: unknown) => x as Error);
    expect((e as Error).message).not.toContain("k-jev");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing). `npx vitest run tests/unit/decider-client.test.ts`

- [ ] **Step 3: Implement** `src/decider/client-http.ts`

```ts
import { z } from "zod";
import { DeciderUnavailable, type Answer, type DeciderProvider, type Question } from "./types.js";

/**
 * The ONE HTTP client for every provider (ADR-0022): Jev's `POST /v1/systemone`, which laya-serve and
 * any "compat" server also speak. The wire format — checked against the official SDK (typesafe_sdk
 * 0.7.1) and docs.typesafe.ai/api, not guessed — is known only to this file.
 */
export interface HttpTarget {
  provider: DeciderProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface SystemOneResult<K extends string> {
  answers: Record<K, Answer>;
  /** Token usage when the server reports it (Jev and laya both do). */
  usage?: { inputTokens: number; outputTokens: number };
  /** The model that answered (Jev reports the versioned id, e.g. jev-1.13.0). */
  model?: string;
}

/**
 * laya 0.3.11 answers a `noul` against the text on some phrasings, with p = 0.89–0.94 on the wrong side
 * (a confident error passes any threshold). Asked as a two-option choice built from the SAME criteria,
 * its errors come with low confidence, which the threshold turns into a fallback. Measured, see ADR-0022.
 */
const NOUL_AS_CHOICE: ReadonlySet<DeciderProvider> = new Set(["laya"]);

/** Confidence of a yes/no: 0 at a coin flip, 1 at certainty — the two-option form of Jev's choice statistic. Jev returns none for noul. */
export function noulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

function toWire(provider: DeciderProvider, q: Question): Record<string, unknown> {
  switch (q.type) {
    case "noul":
      return NOUL_AS_CHOICE.has(provider)
        ? { type: "choice", instructions: q.instructions, criteria: { a: q.criteria.true, b: q.criteria.false } }
        : { type: "noul", instructions: q.instructions, criteria: q.criteria };
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: q.options };
    case "score":
      return { type: "score", instructions: q.instructions, criteria: q.levels };
  }
}

const Prob = z.number().min(0).max(1);
const WireBody = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional() }).optional(),
});
const WireNoul = z.object({ type: z.literal("noul"), noul: Prob });
const WireChoice = z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), Prob), confidence: Prob });
const WireScore = z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), Prob), confidence: Prob });

/** One wire answer, checked against the question it answers. The answer is untrusted input (ADR-0020). */
function fromWire(provider: DeciderProvider, key: string, q: Question, raw: unknown): Answer {
  const bad = (why: string): never => {
    throw new DeciderUnavailable(`invalid answer '${key}': ${why}`);
  };
  if (q.type === "noul" && NOUL_AS_CHOICE.has(provider)) {
    const a = WireChoice.safeParse(raw);
    const p = a.success ? a.data.probabilities.a : undefined;
    if (p === undefined) return bad("expected the two-option choice with option 'a'");
    return { type: "noul", value: p >= 0.5, p, confidence: noulConfidence(p) };
  }
  switch (q.type) {
    case "noul": {
      const a = WireNoul.safeParse(raw);
      if (!a.success) return bad("expected a noul probability");
      return { type: "noul", value: a.data.noul >= 0.5, p: a.data.noul, confidence: noulConfidence(a.data.noul) };
    }
    case "choice": {
      const a = WireChoice.safeParse(raw);
      if (!a.success) return bad("expected a choice");
      if (!Object.hasOwn(q.options, a.data.choice)) return bad(`'${a.data.choice}' was not one of the offered options`);
      return { type: "choice", value: a.data.choice, dist: a.data.probabilities, confidence: a.data.confidence };
    }
    case "score": {
      const a = WireScore.safeParse(raw);
      if (!a.success) return bad("expected a score");
      if (a.data.score < 0 || a.data.score > q.levels.length - 1) return bad("score outside the levels");
      const dist = q.levels.map((_, i) => a.data.probabilities[String(i)] ?? 0);
      return { type: "score", value: a.data.score, dist, confidence: a.data.confidence };
    }
  }
}

/** One `POST /v1/systemone`. Anything but a complete, valid answer set → DeciderUnavailable (`status` set on an HTTP error). */
export async function postSystemOne<K extends string>(
  target: HttpTarget,
  state: string,
  questions: Record<K, Question>,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<SystemOneResult<K>> {
  const entries = Object.entries(questions) as [K, Question][];
  const wire = Object.fromEntries(entries.map(([k, q]) => [k, toWire(target.provider, q)]));
  let res: Response;
  try {
    res = await fetchFn(`${target.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) },
      body: JSON.stringify({ state, model: target.model, questions: wire }),
      signal,
    });
  } catch (e) {
    throw new DeciderUnavailable(`request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new DeciderUnavailable(`HTTP ${res.status}`, res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new DeciderUnavailable("the response is not JSON");
  }
  const body = WireBody.safeParse(json);
  if (!body.success) throw new DeciderUnavailable("the response is not a /v1/systemone answer set");
  const answers = {} as Record<K, Answer>;
  for (const [k, q] of entries) {
    if (!Object.hasOwn(body.data.answers, k)) throw new DeciderUnavailable(`missing answer '${k}'`);
    answers[k] = fromWire(target.provider, k, q, body.data.answers[k]);
  }
  const u = body.data.usage;
  return {
    answers,
    ...(body.data.model ? { model: body.data.model } : {}),
    ...(u?.input_tokens !== undefined ? { usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens ?? 0 } } : {}),
  };
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(decider): one HTTP client for Jev, laya and compat servers`

### Task 3: Guard — timeout, one retry, per-run ceiling

**Files:**
- Create: `src/decider/guarded.ts`
- Test: `tests/unit/decider-client.test.ts` (append a `describe("guarded")`)

**Interfaces:**
- Produces: `guarded({ timeoutMs, maxCalls, retryDelayMs? }) → { readonly calls: number; run<T>(attempt: (signal: AbortSignal) => Promise<T>): Promise<T> }`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { guarded } from "../../src/decider/guarded.js";

describe("guarded — bounds on every decider call", () => {
  it("retries exactly once on 429/5xx, then gives up", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 5, retryDelayMs: 0 });
    const attempt = vi.fn(async () => { throw new DeciderUnavailable("HTTP 503", 503); });
    await expect(g.run(attempt)).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
  it("a 429 then success → the answer", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 5, retryDelayMs: 0 });
    let n = 0;
    await expect(g.run(async () => { if (n++ === 0) throw new DeciderUnavailable("HTTP 429", 429); return "ok"; })).resolves.toBe("ok");
  });
  it("4xx other than 429, and network errors, are not retried", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 5, retryDelayMs: 0 });
    const a422 = vi.fn(async () => { throw new DeciderUnavailable("HTTP 422", 422); });
    const aNet = vi.fn(async () => { throw new DeciderUnavailable("request failed"); });
    await expect(g.run(a422)).rejects.toThrow();
    await expect(g.run(aNet)).rejects.toThrow();
    expect(a422).toHaveBeenCalledTimes(1);
    expect(aNet).toHaveBeenCalledTimes(1);
  });
  it("timeout → DeciderUnavailable and the in-flight request is aborted", async () => {
    const g = guarded({ timeoutMs: 20, maxCalls: 5 });
    let aborted = false;
    const slow = (signal: AbortSignal) => new Promise<string>((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    });
    await expect(g.run(slow)).rejects.toThrow(/timeout after 20 ms/);
    expect(aborted).toBe(true);
  });
  it("a request that rejects AFTER the timeout does not surface as an unhandled rejection", async () => {
    const g = guarded({ timeoutMs: 10, maxCalls: 5 });
    const late = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late")), 40));
    await expect(g.run(late)).rejects.toThrow(/timeout/);
    await new Promise((r) => setTimeout(r, 60)); // vitest fails the run on an unhandled rejection
  });
  it("the per-run ceiling refuses without calling the server", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 2 });
    const attempt = vi.fn(async () => "ok");
    await g.run(attempt);
    await g.run(attempt);
    await expect(g.run(attempt)).rejects.toThrow(/ceiling/);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(g.calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `src/decider/guarded.ts`

```ts
import { DeciderUnavailable } from "./types.js";

export interface GuardOptions {
  timeoutMs: number;
  /** Per-run ceiling on decide() calls (DECIDER_MAX_CALLS). A retry is part of its call, not a new one. */
  maxCalls: number;
  /** Pause before the single retry on 429/5xx. */
  retryDelayMs?: number;
}

const retryable = (e: unknown): boolean =>
  e instanceof DeciderUnavailable && e.status !== undefined && (e.status === 429 || e.status >= 500);

/**
 * The layer's bounds (ADR-0022, spec §3.6): a per-run call ceiling, ONE timeout over the whole call
 * (retry included), exactly one retry on 429/5xx. Everything that goes wrong surfaces as
 * DeciderUnavailable, so a call site has one thing to catch.
 * ponytail: fixed retry delay; honour `retry-after` if Jev's 429s turn out to need it.
 */
export function guarded(opts: GuardOptions) {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async run<T>(attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (calls >= opts.maxCalls) throw new DeciderUnavailable(`call ceiling reached (${opts.maxCalls} per run)`);
      calls += 1;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new DeciderUnavailable(`timeout after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      });
      const work = (async (): Promise<T> => {
        try {
          return await attempt(ctl.signal);
        } catch (e) {
          if (!retryable(e) || ctl.signal.aborted) throw e;
          await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 250));
          return attempt(ctl.signal);
        }
      })();
      work.catch(() => undefined); // the race may settle first: never leave the loser's rejection unhandled
      try {
        return await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(decider): bound every call — timeout, one retry on 429/5xx, per-run ceiling`

### Task 4: Configuration

**Files:**
- Modify: `src/config/schema.ts` (add `DeciderProviderSchema`, `AppConfig.decider?`)
- Modify: `src/config/index.ts` (export `parseDeciderConfig`; call it in `loadConfig`)
- Modify: `src/core/config.ts` (`ConfigFlags.decider` → `CAIRN_DECIDER`)
- Test: `tests/unit/decider-config.test.ts`

**Interfaces:**
- Consumes: `DeciderConfig`, `DECIDER_USES` (Task 1).
- Produces: `parseDeciderConfig(read: (name: string) => string | undefined): DeciderConfig | undefined`; `AppConfig.decider?: DeciderConfig` (key absent when off); `ConfigFlags.decider?: string`.

- [ ] **Step 1: Write the failing test** — `tests/unit/decider-config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { loadConfig, parseDeciderConfig } from "../../src/config/index.js";
import { createEnvReader } from "../../src/config/env.js";
import { resolveConfig } from "../../src/core/config.js";

const BASE = { ANTHROPIC_API_KEY: "sk-ant" };
const parse = (env: Record<string, string | undefined>) => parseDeciderConfig(createEnvReader(env, () => undefined));

describe("decider config — opt-in only (ADR-0022)", () => {
  it("unset or off → no decider, and AppConfig has no `decider` key at all", () => {
    expect(parse({})).toBeUndefined();
    expect(parse({ DECIDER: "off" })).toBeUndefined();
    expect("decider" in loadConfig(BASE)).toBe(false);
    expect("decider" in loadConfig({ ...BASE, DECIDER: "off" })).toBe(false);
  });
  it("a key alone enables nothing", () => {
    expect(parse({ TYPESAFE_API_KEY: "k", LAYA_API_KEY: "l", DECIDER_API_KEY: "d" })).toBeUndefined();
  });
  it("jev: defaults and its own key", () => {
    expect(parse({ DECIDER: "jev", TYPESAFE_API_KEY: "k" })).toEqual({
      provider: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "k",
      uses: ["repair-triage", "coverage"], minConfidence: 0.75, timeoutMs: 10000, maxCalls: 200,
    });
  });
  it("jev without a key fails at start, with the variable named", () => {
    expect(() => parse({ DECIDER: "jev" })).toThrow(/TYPESAFE_API_KEY/);
  });
  it("laya/compat need DECIDER_BASE_URL", () => {
    expect(() => parse({ DECIDER: "laya" })).toThrow(/DECIDER_BASE_URL/);
    expect(() => parse({ DECIDER: "compat" })).toThrow(/DECIDER_BASE_URL/);
  });
  it("each provider reads only its own key — a TypeSafe key never goes to laya or compat", () => {
    const env = { TYPESAFE_API_KEY: "cloud", LAYA_API_KEY: "local", DECIDER_API_KEY: "other", DECIDER_BASE_URL: "http://127.0.0.1:8000" };
    expect(parse({ ...env, DECIDER: "laya" })?.apiKey).toBe("local");
    expect(parse({ ...env, DECIDER: "compat" })?.apiKey).toBe("other");
    expect(parse({ DECIDER: "compat", TYPESAFE_API_KEY: "cloud", DECIDER_BASE_URL: "http://x.test" })?.apiKey).toBeUndefined();
  });
  it("every variable reads with the CAIRN_ prefix too", () => {
    const d = parse({ CAIRN_DECIDER: "laya", CAIRN_DECIDER_BASE_URL: "http://127.0.0.1:8000", CAIRN_DECIDER_MIN_CONFIDENCE: "0.9" });
    expect(d).toMatchObject({ provider: "laya", minConfidence: 0.9 });
  });
  it.each([
    [{ DECIDER: "gpt" }, /Invalid DECIDER/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_USES: "repair-traige" }, /Unknown DECIDER_USES entry 'repair-traige'/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_MIN_CONFIDENCE: "1.5" }, /DECIDER_MIN_CONFIDENCE/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_TIMEOUT_MS: "0" }, /DECIDER_TIMEOUT_MS/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_MAX_CALLS: "-1" }, /DECIDER_MAX_CALLS/],
    [{ DECIDER: "laya", DECIDER_BASE_URL: "not a url" }, /DECIDER_BASE_URL/],
  ])("rejects %o", (env, msg) => {
    expect(() => parse(env)).toThrow(msg);
  });
  it("the --decider flag beats the environment — including CAIRN_DECIDER", () => {
    const env = { ...BASE, CAIRN_DECIDER: "jev", TYPESAFE_API_KEY: "k" };
    expect(resolveConfig({}, env).decider?.provider).toBe("jev");
    expect("decider" in resolveConfig({ decider: "off" }, env)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`parseDeciderConfig` not exported).

- [ ] **Step 3: Implement**
  - `src/config/schema.ts`: add
    ```ts
    import type { DeciderConfig } from "../decider/types.js";
    /** ADR-0022 decision layer: `off` or a provider. */
    export const DeciderProviderSchema = z.enum(["off", "jev", "laya", "compat"]);
    ```
    and in `AppConfig`: `/** ADR-0022: the opt-in decision layer — absent unless DECIDER / --decider names a provider. */ decider?: DeciderConfig;`
  - `src/config/index.ts`: in `loadConfig`, before `return`, `const decider = parseDeciderConfig(read);` and spread `...(decider ? { decider } : {})` as the LAST property of the returned object (the key stays absent when off). Add:
    ```ts
    const TRUE = new Set(["1", "true", "yes", "on"]);

    /** A number env var with a default and a validity rule; throws a clear error naming the variable. */
    function envNumber(read: (n: string) => string | undefined, name: string, dflt: number, ok: (n: number) => boolean, rule: string): number {
      const raw = read(name)?.trim();
      if (!raw) return dflt;
      const n = Number(raw);
      if (!ok(n)) throw new Error(`Invalid ${name}='${raw}'. ${rule}`);
      return n;
    }

    /**
     * ADR-0022: the opt-in decision layer. undefined unless DECIDER names a provider — a key alone enables
     * nothing (spec §3.2). Each provider reads ONLY its own key, so a TypeSafe cloud key is never sent to
     * a laya/compat server. Misconfiguration fails here, at start, not in the middle of a run.
     */
    export function parseDeciderConfig(read: (name: string) => string | undefined): DeciderConfig | undefined {
      const raw = read("DECIDER")?.trim().toLowerCase();
      if (!raw || raw === "off") return undefined;
      const parsed = DeciderProviderSchema.safeParse(raw);
      if (!parsed.success || parsed.data === "off") throw new Error(`Invalid DECIDER='${raw}'. Allowed: off | jev | laya | compat.`);
      const provider = parsed.data;
      const baseUrl = read("DECIDER_BASE_URL")?.trim() || (provider === "jev" ? "https://api.typesafe.ai" : "");
      if (!baseUrl) {
        throw new Error(`DECIDER=${provider} needs DECIDER_BASE_URL — the server's address, e.g. http://127.0.0.1:8000 (see docs/decider.md).`);
      }
      if (!/^https?:\/\//i.test(baseUrl) || !URL.canParse(baseUrl)) throw new Error(`Invalid DECIDER_BASE_URL='${baseUrl}' — expected an http(s) URL.`);
      const keyVar = provider === "jev" ? "TYPESAFE_API_KEY" : provider === "laya" ? "LAYA_API_KEY" : "DECIDER_API_KEY";
      const apiKey = read(keyVar)?.trim() || undefined;
      if (provider === "jev" && !apiKey) throw new Error("DECIDER=jev needs TYPESAFE_API_KEY (your TypeSafe API key).");
      const usesRaw = read("DECIDER_USES")?.trim() || "repair-triage,coverage";
      const uses = [...new Set(usesRaw.split(",").map((s) => s.trim()).filter(Boolean))];
      for (const u of uses) {
        if (!(DECIDER_USES as readonly string[]).includes(u)) {
          throw new Error(`Unknown DECIDER_USES entry '${u}' (supported in this version: ${DECIDER_USES.join(", ")}).`);
        }
      }
      return {
        provider,
        baseUrl,
        model: read("DECIDER_MODEL")?.trim() || "jev-latest",
        ...(apiKey ? { apiKey } : {}),
        uses: uses as DeciderUse[],
        minConfidence: envNumber(read, "DECIDER_MIN_CONFIDENCE", 0.75, (n) => n >= 0 && n <= 1, "Must be a number from 0 to 1."),
        timeoutMs: envNumber(read, "DECIDER_TIMEOUT_MS", 10_000, (n) => Number.isInteger(n) && n > 0, "Must be a positive integer (ms)."),
        maxCalls: envNumber(read, "DECIDER_MAX_CALLS", 200, (n) => Number.isInteger(n) && n >= 0, "Must be a non-negative integer."),
      };
    }
    ```
    (`TRUE` is used by `DECIDER_SHADOW` in Task 8 — add it there, not here.) Note the jev test expects no `apiKey`-less shape surprises: the object key order above is what `toEqual` compares loosely; keep it.
  - `src/core/config.ts`: `ConfigFlags` gains
    ```ts
    /** `--decider <off|jev|laya|compat>` (ADR-0022). Written as CAIRN_DECIDER — the highest-precedence spelling — so the flag beats any env form. */
    decider?: string;
    ```
    and `resolveConfig`: `if (flags.decider) merged.CAIRN_DECIDER = flags.decider;`

- [ ] **Step 4: Run — expect PASS**; then `npx vitest run tests/unit/config.test.ts tests/unit/config-env.test.ts tests/unit/core-config.test.ts` stay green.
- [ ] **Step 5: Commit** `feat(config): opt-in DECIDER configuration, validated at start`

### Task 5: `makeDecider` — ledger, telemetry, redaction, data-destination warning

**Files:**
- Create: `src/decider/redact.ts`, `src/decider/index.ts`
- Modify: `src/llm/cost.ts` (`record(role, model, usage, price?)`)
- Modify: `src/telemetry/index.ts` (`DecisionTrace`, optional `recordDecision`)
- Test: `tests/unit/decider.test.ts`, `tests/unit/cost.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `makeDecider(cfg: DeciderConfig | undefined, deps: DeciderDeps): Decider | undefined`; `DeciderDeps { ledger: CostLedger; telemetry?: Pick<Telemetry, "recordDecision">; secrets?: readonly string[]; warn?: (msg: string) => void; fetchFn?: typeof fetch }`; `dataDestination(baseUrl) → { local: boolean; label: string }`; `secretValues(knowledgeText, env): string[]`; `redact(text, secrets): string`; `Telemetry.recordDecision?(d: DecisionTrace)`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/decider.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { makeDecider, dataDestination } from "../../src/decider/index.js";
import { secretValues, redact } from "../../src/decider/redact.js";
import { CostLedger } from "../../src/llm/cost.js";
import { DeciderUnavailable, type DeciderConfig, type Question } from "../../src/decider/types.js";

const cfg = (over: Partial<DeciderConfig> = {}): DeciderConfig => ({
  provider: "jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "k",
  uses: ["repair-triage", "coverage"], minConfidence: 0.75, timeoutMs: 1000, maxCalls: 10, ...over,
});
const q: Question = { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } };
const okFetch = (usage = { input_tokens: 1_000_000, output_tokens: 5 }) =>
  vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.95 } }, usage }))) as unknown as typeof fetch;

describe("makeDecider", () => {
  it("no config → undefined: nothing downstream can even reach a decider", () => {
    expect(makeDecider(undefined, { ledger: new CostLedger() })).toBeUndefined();
  });
  it("a successful call is priced into the ledger under the `decider` role (jev: $0.042 / 1M in)", async () => {
    const ledger = new CostLedger();
    const d = makeDecider(cfg(), { ledger, fetchFn: okFetch(), warn: () => undefined })!;
    await d.decide("coverage", "S", { q });
    const row = ledger.report().perRole.find((r) => r.role === "decider")!;
    expect(row).toMatchObject({ calls: 1, inputTokens: 1_000_000, outputTokens: 5, costUsd: 0.042 });
  });
  it("laya is free; compat has no known price", async () => {
    for (const [provider, cost] of [["laya", 0], ["compat", null]] as const) {
      const ledger = new CostLedger();
      const d = makeDecider(cfg({ provider, baseUrl: "http://127.0.0.1:8000" }), {
        ledger, warn: () => undefined,
        fetchFn: vi.fn(async () => new Response(JSON.stringify({ answers: { q: provider === "laya"
          ? { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 }
          : { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 0 } }))) as unknown as typeof fetch,
      })!;
      await d.decide("coverage", "S", { q });
      expect(ledger.report().perRole.find((r) => r.role === "decider")?.costUsd).toBe(cost);
    }
  });
  it("any failure is DeciderUnavailable, traced as a fallback, and never priced", async () => {
    const ledger = new CostLedger();
    const traces: { fallback: boolean; reason?: string }[] = [];
    const d = makeDecider(cfg(), {
      ledger, warn: () => undefined, telemetry: { recordDecision: (t) => void traces.push(t) },
      fetchFn: vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    })!;
    await expect(d.decide("coverage", "S", { q })).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(traces).toEqual([expect.objectContaining({ fallback: true, reason: "HTTP 500" })]);
    expect(ledger.report().perRole).toEqual([]);
  });
  it("caps are checked before the request: an over-long state never reaches fetch", async () => {
    const fetchFn = okFetch();
    const d = makeDecider(cfg({ provider: "laya", baseUrl: "http://127.0.0.1:8000" }), { ledger: new CostLedger(), fetchFn, warn: () => undefined })!;
    await expect(d.decide("coverage", "x".repeat(1201), { q })).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("secrets are scrubbed from the state before it leaves the process", async () => {
    const fetchFn = okFetch();
    const d = makeDecider(cfg(), { ledger: new CostLedger(), fetchFn, warn: () => undefined, secrets: ["Sup3rS3cret!"] })!;
    await d.decide("coverage", "type Sup3rS3cret! into Password", { q });
    const body = JSON.parse(String((fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body));
    expect(body.state).toBe("type ‹redacted› into Password");
  });
  it("warns once per process when data leaves the machine; never for localhost", () => {
    const warn = vi.fn();
    makeDecider(cfg({ provider: "laya", baseUrl: "http://127.0.0.1:8000" }), { ledger: new CostLedger(), warn });
    expect(warn).not.toHaveBeenCalled();
    makeDecider(cfg(), { ledger: new CostLedger(), warn });
    makeDecider(cfg(), { ledger: new CostLedger(), warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/TypeSafe cloud.*DECIDER=laya/);
  });
});

describe("dataDestination", () => {
  it.each([
    ["http://127.0.0.1:8000", true, "this machine"],
    ["http://localhost:9000", true, "this machine"],
    ["http://[::1]:8000", true, "this machine"],
    ["https://api.typesafe.ai", false, "TypeSafe cloud"],
    ["https://laya.example.com", false, "laya.example.com"],
  ])("%s", (url, local, label) => {
    expect(dataDestination(url).local).toBe(local);
    expect(dataDestination(url).label).toContain(label);
  });
});

describe("secretValues / redact (spec §3.7)", () => {
  it("collects knowledge values under secret-looking keys, and secret env values", () => {
    const s = secretValues("Admin login: admin@acme.test\npassword: Sup3rS3cret!\nSpinner: shows loading", {
      ANTHROPIC_API_KEY: "sk-ant-0123456789", PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc",
    });
    expect(s).toContain("Sup3rS3cret!");
    expect(s).toContain("sk-ant-0123456789");
    expect(s).not.toContain("shows"); // "Spinner" is not a "pin"
    expect(s).not.toContain("/usr/bin:/bin");
    expect(s).not.toContain("abc"); // too short to be a credential, too common to scrub
  });
  it("redacts every occurrence, longest secret first", () => {
    expect(redact("a SECRET-LONG b SECRET c", ["SECRET", "SECRET-LONG"].sort((x, y) => y.length - x.length))).toBe("a ‹redacted› b ‹redacted› c");
  });
});
```

Append to `tests/unit/cost.test.ts`:

```ts
describe("CostLedger — explicit price (ADR-0022 decider)", () => {
  it("an explicit price wins over the table; the role appears only once recorded", () => {
    const l = new CostLedger({});
    expect(l.report().perRole).toEqual([]);
    l.record("decider", "jev-latest", { inputTokens: 1_000_000, outputTokens: 0 }, { inputPer1M: 0.042, outputPer1M: 0 });
    expect(l.report().perRole[0]).toMatchObject({ role: "decider", costUsd: 0.042 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**
  - `src/llm/cost.ts`: `record(role: string, model: string, usage: TokenUsage, price?: ModelPrice): void` with `const p = price ?? this.pricing[model];` (doc: "An explicit price wins — the decider prices by provider, not by model name (ADR-0022)").
  - `src/decider/redact.ts`:
    ```ts
    /**
     * Values that must never reach a decider (spec §3.7). Cairn never PUTS knowledge, storageState,
     * screenshots or env into a state — but a designed case can ECHO a credential it read in a knowledge
     * file ("type Sup3rS3cret! into Password"), and a test error can echo a typed value. So every state is
     * scrubbed of the values that look like secrets in this run's knowledge and environment.
     */
    const SECRET_WORD = /(^|[^a-z])(pass(word)?|passwd|pwd|secret|token|api[_-]?key|key|otp|pin|credentials?)([^a-z]|$)/i;

    export function secretValues(knowledgeText: string, env: Record<string, string | undefined>): string[] {
      const out = new Set<string>();
      for (const m of knowledgeText.matchAll(/^[ \t>*-]*([^:=\n]{1,40}?)\s*[:=]\s*[`"']?([^\s`"',;]{4,})/gm)) {
        if (SECRET_WORD.test(m[1] ?? "") && m[2]) out.add(m[2]);
      }
      for (const [k, v] of Object.entries(env)) if (v && v.length >= 8 && SECRET_WORD.test(k)) out.add(v);
      return [...out].sort((a, b) => b.length - a.length); // longest first: a secret containing another is scrubbed whole
    }

    export function redact(text: string, secrets: readonly string[]): string {
      let out = text;
      for (const s of secrets) out = out.split(s).join("‹redacted›");
      return out;
    }
    ```
  - `src/telemetry/index.ts`: export
    ```ts
    /** ADR-0022: one decider call, as reported to tracing. */
    export interface DecisionTrace {
      use: string; provider: string; model: string; startTime: Date; endTime: Date;
      state: string; questions: unknown; answers?: unknown; fallback: boolean; reason?: string; minConfidence: number;
    }
    ```
    and on `Telemetry`: `/** ADR-0022: a decider call as a span under the active stage, plus a `decider.<use>.confidence` score. Absent when tracing is off. */ recordDecision?: (d: DecisionTrace) => void;`. Enabled path implementation:
    ```ts
    const recordDecision = (d: DecisionTrace): void => {
      try {
        const span = lfTracing.startObservation(
          `decider.${d.use}`,
          {
            input: { state: d.state.slice(0, 2000), questions: d.questions },
            output: d.answers,
            metadata: { provider: d.provider, model: d.model, latencyMs: d.endTime.getTime() - d.startTime.getTime(),
              fallback: d.fallback, reason: d.reason, minConfidence: d.minConfidence },
            ...(d.fallback ? { level: "WARNING" as const, statusMessage: d.reason } : {}),
          },
          { startTime: d.startTime },
        );
        span.end(d.endTime);
        const confidences = Object.values((d.answers ?? {}) as Record<string, { confidence?: unknown }>)
          .map((a) => a.confidence).filter((c): c is number => typeof c === "number");
        const traceId = lfTracing.getActiveTraceId();
        if (traceId && confidences.length > 0) {
          client.score.create({ traceId, observationId: span.id, name: `decider.${d.use}.confidence`,
            value: Math.min(...confidences), dataType: "NUMERIC" });
        }
      } catch {
        // tracing is best-effort — it must never touch the run
      }
    };
    ```
    (verify `span.end(Date)`, `span.id` and `score.create({observationId})` against `@langfuse/*` 5.4 typings when implementing; adjust names, not behavior).
  - `src/decider/index.ts`:
    ```ts
    import { CostLedger } from "../llm/cost.js";
    import type { Telemetry } from "../telemetry/index.js";
    import { CAPS, checkCaps } from "./capabilities.js";
    import { postSystemOne, type HttpTarget } from "./client-http.js";
    import { guarded } from "./guarded.js";
    import { redact } from "./redact.js";
    import { DeciderUnavailable, type Decider, type DeciderConfig, type Question } from "./types.js";

    export { DeciderUnavailable, DECIDER_USES, DECIDER_PROVIDERS } from "./types.js";
    export type { Answer, Decider, DeciderCaps, DeciderConfig, DeciderProvider, DeciderUse, Question } from "./types.js";
    export { secretValues } from "./redact.js";

    export interface DeciderDeps {
      /** Where decider tokens and cost land (spec §5.5: a `decider` row, only when the decider is on). */
      ledger: CostLedger;
      telemetry?: Pick<Telemetry, "recordDecision">;
      /** Scrubbed from every state before it leaves the process (redact.ts). */
      secrets?: readonly string[];
      /** One-line notices (where the data goes). Default: stderr. */
      warn?: (msg: string) => void;
      fetchFn?: typeof fetch;
    }

    export function httpTarget(cfg: DeciderConfig): HttpTarget {
      return { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) };
    }

    /** Where requests to `baseUrl` physically go — for the start-up notice and `cairn doctor`. */
    export function dataDestination(baseUrl: string): { local: boolean; label: string } {
      const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "::1" || /^127\./.test(host)) return { local: true, label: "this machine (localhost)" };
      if (host === "api.typesafe.ai") return { local: false, label: "TypeSafe cloud (api.typesafe.ai)" };
      return { local: false, label: `a remote server (${host})` };
    }

    let warnedRemote = false; // once per process, like the env deprecation notices

    /** ~4 chars/token over the state and the questions — only when a server reports no usage. */
    function estimateUsage(state: string, questions: Record<string, Question>): { inputTokens: number; outputTokens: number } {
      return { inputTokens: Math.ceil((state.length + JSON.stringify(questions).length) / 4), outputTokens: 0 };
    }

    /**
     * The decision layer (ADR-0022) — or `undefined` when DECIDER is off, which is what keeps a run without
     * the flag byte-identical: every use point is gated on this value, and there is no other switch.
     */
    export function makeDecider(cfg: DeciderConfig | undefined, deps: DeciderDeps): Decider | undefined {
      if (!cfg) return undefined;
      const caps = CAPS[cfg.provider];
      const target = httpTarget(cfg);
      const guard = guarded({ timeoutMs: cfg.timeoutMs, maxCalls: cfg.maxCalls });
      const dest = dataDestination(cfg.baseUrl);
      if (!dest.local && !warnedRemote) {
        warnedRemote = true;
        (deps.warn ?? ((m: string) => void process.stderr.write(`${m}\n`)))(
          `[cairn] DECIDER=${cfg.provider} sends ARIA fragments, case texts and test errors to ${dest.label}. ` +
            "For an app behind a login, prefer DECIDER=laya (runs locally) — see docs/decider.md.",
        );
      }
      return {
        provider: cfg.provider,
        model: cfg.model,
        caps,
        uses: new Set(cfg.uses),
        minConfidence: cfg.minConfidence,
        async decide(use, rawState, questions) {
          const state = redact(rawState, deps.secrets ?? []);
          const startTime = new Date();
          const trace = { use, provider: cfg.provider, startTime, state, questions, minConfidence: cfg.minConfidence };
          try {
            checkCaps(caps, state, questions);
            const res = await guard.run((signal) => postSystemOne(target, state, questions, signal, deps.fetchFn));
            deps.ledger.record("decider", cfg.model, res.usage ?? estimateUsage(state, questions), caps.price);
            deps.telemetry?.recordDecision?.({ ...trace, model: res.model ?? cfg.model, endTime: new Date(), answers: res.answers, fallback: false });
            return res.answers;
          } catch (e) {
            const err = e instanceof DeciderUnavailable ? e : new DeciderUnavailable(e instanceof Error ? e.message : String(e));
            deps.telemetry?.recordDecision?.({ ...trace, model: cfg.model, endTime: new Date(), fallback: true, reason: err.message });
            throw err;
          }
        },
      };
    }
    ```
  - Test hygiene: `warnedRemote` is module state; the warn-once test must run in its own module instance or reset — expose nothing for tests; instead, order the test so the first remote `makeDecider` in the file is the one asserted (vitest isolates modules per test file).

- [ ] **Step 4: Run — expect PASS**, plus `tests/unit/cost.test.ts`, `tests/unit/telemetry.test.ts` green.
- [ ] **Step 5: Commit** `feat(decider): makeDecider — ledger row, tracing, secret scrubbing, data-destination notice`

### Task 6: `cairn doctor`, `--decider` on explore/design/automate, MCP pass-through

**Files:**
- Modify: `src/decider/index.ts` (add `deciderDoctorReport`)
- Modify: `src/cli/index.ts` (doctor action async; `--decider` on `design`, `automate`; pass to `resolveConfig`)
- Modify: `src/core/modalities/explore.ts` (`ExploreFlags.decider`; pass to `resolveConfig`)
- Modify: `src/mcp/tools.ts` (`decider` in `TOOL_INPUT_SHAPE` and `AUTOMATE_INPUT_SHAPE`)
- Test: `tests/unit/decider-doctor.test.ts`, `tests/unit/cli-modalities.test.ts` (+ snapshot), `tests/unit/mcp.test.ts`

**Interfaces:**
- Produces: `deciderDoctorReport(env, fetchFn?) → Promise<string[]>` (`[]` when DECIDER is off).

- [ ] **Step 1: Write the failing tests**
  - `tests/unit/decider-doctor.test.ts`:
    ```ts
    import { describe, it, expect, vi } from "vitest";
    import { deciderDoctorReport } from "../../src/decider/index.js";

    describe("cairn doctor — decision layer section", () => {
      it("off → nothing printed", async () => {
        expect(await deciderDoctorReport({})).toEqual([]);
      });
      it("config error → one clear line, no crash", async () => {
        const lines = await deciderDoctorReport({ DECIDER: "jev" });
        expect(lines.join("\n")).toMatch(/✗ .*TYPESAFE_API_KEY/);
      });
      it("prints provider, where data goes, and the result + latency of one real noul call", async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: "laya-rl-agent",
          answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 } } }))) as unknown as typeof fetch;
        const text = (await deciderDoctorReport({ DECIDER: "laya", DECIDER_BASE_URL: "http://127.0.0.1:8000", LAYA_API_KEY: "l" }, fetchFn)).join("\n");
        expect(text).toContain("Provider: laya");
        expect(text).toContain("this machine (localhost)");
        expect(text).toMatch(/✓ Test call \(noul\): \d+ ms/);
        expect(text).not.toContain("l\n"); // never prints a key
      });
      it("a failing server is reported, not thrown", async () => {
        const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
        const text = (await deciderDoctorReport({ DECIDER: "jev", TYPESAFE_API_KEY: "bad" }, fetchFn)).join("\n");
        expect(text).toContain("TypeSafe cloud");
        expect(text).toMatch(/✗ Test call failed: HTTP 401/);
      });
    });
    ```
  - `tests/unit/cli-modalities.test.ts`: add `"--decider"` to the explore flag list, `toHaveLength(19)`; in "maps flags to runExploration", pass `"--decider", "off"` and assert `"decider" in runExploration.mock.calls[0][0].config` is `false`.
  - `tests/unit/mcp.test.ts`: `exploreTool({ url, decider: "off" }, deps)` → `deps.resolveConfig` called with `expect.objectContaining({ decider: "off" })`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**
  - `deciderDoctorReport` in `src/decider/index.ts`:
    ```ts
    import { createEnvReader } from "../config/env.js";
    import { parseDeciderConfig } from "../config/index.js";

    const DOCTOR_QUESTION: Question = {
      type: "noul",
      instructions: "Is this text a connectivity check?",
      criteria: { true: "The text says it is a connectivity check", false: "The text is about something else" },
    };

    /** `cairn doctor` (spec §4): provider, where the data goes, and ONE real noul call with its latency. Never throws. */
    export async function deciderDoctorReport(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<string[]> {
      const head = ["", "Cairn decision layer (DECIDER — ADR-0022)"];
      let cfg: DeciderConfig | undefined;
      try {
        cfg = parseDeciderConfig(createEnvReader(env, () => undefined));
      } catch (e) {
        return [...head, `  ✗ ${(e as Error).message}`];
      }
      if (!cfg) return [];
      const dest = dataDestination(cfg.baseUrl);
      const lines = [
        ...head,
        `  Provider: ${cfg.provider} · model: ${cfg.model}`,
        `  Base URL: ${cfg.baseUrl}`,
        `  Data goes to: ${dest.label}${dest.local ? "" : " — ARIA fragments, case texts and test errors leave this machine"}`,
        `  Uses: ${cfg.uses.join(", ")} · min confidence ${cfg.minConfidence} · timeout ${cfg.timeoutMs} ms · ≤ ${cfg.maxCalls} calls/run`,
      ];
      const t0 = Date.now();
      try {
        const r = await guarded({ timeoutMs: cfg.timeoutMs, maxCalls: 1 }).run((signal) =>
          postSystemOne(httpTarget(cfg), "Cairn doctor connectivity check.", { q: DOCTOR_QUESTION }, signal, fetchFn));
        lines.push(`  ✓ Test call (noul): ${Date.now() - t0} ms · answered by ${r.model ?? cfg.model}`);
      } catch (e) {
        lines.push(`  ✗ Test call failed: ${(e as Error).message}`);
      }
      return lines;
    }
    ```
  - CLI: doctor action → `async () => { for (const l of doctorReport()) …; for (const l of await deciderDoctorReport(process.env)) … }`; description → `"Diagnose the setup: Cairn's Playwright + the Chromium it expects, and the decision layer when DECIDER is set"`.
  - `--decider` option text (same on the three commands): `"opt-in decision layer: off | jev | laya | compat (sets DECIDER) — see docs/decider.md"`. `design`/`automate` actions pass `decider: opts.decider` to `resolveConfig`; `exploreModality` passes `decider: opts.decider`.
  - MCP: `decider: z.string().optional().describe("Opt-in decision layer: off | jev | laya | compat (env DECIDER*; see docs/decider.md)")` in both shapes; `buildExploreInput` and `automateTool` pass it to `resolveConfig`.
- [ ] **Step 4: Run**, update the snapshot deliberately: `npx vitest run tests/unit/cli-modalities.test.ts -u`; then check the diff is small (`git diff --numstat tests/unit/__snapshots__/`) — a 0/huge line count means a CRLF flip, `git checkout` it (repo memory `cli-surface-lock`).
- [ ] **Step 5: Commit** `feat(cli): --decider on explore/design/automate, decider section in cairn doctor, MCP pass-through`

### Task 7: ADR-0022, config docs, CHANGELOG — gate, PR, merge

**Files:**
- Create: `docs/adr/0022-optional-decision-layer.md`
- Modify: `docs/adr/README.md` (22 records, row, verified-by-command line), `docs/configuration.md` (a "Decision layer" block), `CHANGELOG.md` ([Unreleased] → Added), `README.md` (ADR range 0001–0022)
- Modify: `vitest.config.ts` (add the pure decider modules to the coverage `include` list)

- [ ] **Step 1: ADR-0022** — Context (§1), Decision (a separate seam; default off; key ≠ enable; per-provider keys; asymmetry; bounds; caps before the request; redaction; noul-as-choice for laya; noul confidence `|2p−1|`; no schema bump — with the byte-identity reasoning), the **measured facts** section (wire format sources; laya context 512/1024, silent truncation, confident noul errors vs low-confidence choice errors, differing confidence statistics), Consequences, Rejected alternatives (a role in `RoleRouter`; enable on key; replace judge by default; the `@typesafe-ai/sdk` dependency; clipping an over-long state instead of refusing; one shared key variable), Open questions answered (§13.1–4, 6 deferred to PR 4, 7 → v2, 5 = owner's call).
- [ ] **Step 2: Docs + CHANGELOG** (English; no Jev numbers in `docs/cost.md`).
- [ ] **Step 3: Gate** — each command separately, reading the numbers, not the exit status of an `echo`:
  `npm run build` · `npm run lint` · `npm run test:coverage` → the test count must be 726 + the new tests, 0 failed; coverage thresholds met.
- [ ] **Step 4: Live check (acceptance PR 1)** — laya on this machine: `DECIDER=laya DECIDER_BASE_URL=http://127.0.0.1:8000 node dist/cli/index.js doctor` → `✓ Test call`. Jev: same with `DECIDER=jev` and a real `TYPESAFE_API_KEY` (operator-provided; `CAIRN_TYPESAFE_API_KEY` in `.env` wins over the machine-wide laya token).
- [ ] **Step 5: PR** — `git push -u origin feat/decider-skeleton`; `gh pr create` (grep the body for assistant names / "Generated with" first); wait for CI; merge when green; `git checkout main && git pull`.

---

# PR 2 — shadow mode + phase 1 (branch `feat/decider-shadow-phase1`)

### Task 8: Shadow mode plumbing

**Files:**
- Modify: `src/decider/types.ts` (`ShadowEntry`, `ShadowLog`, `DeciderSummary`; `Decider.shadow?`, `Decider.summary()`; `DeciderConfig.shadow`)
- Modify: `src/config/index.ts` (`DECIDER_SHADOW`; error without a provider), `src/core/config.ts` (`deciderShadow` → `CAIRN_DECIDER_SHADOW=1`)
- Modify: `src/decider/index.ts` (private ledger in shadow; `summary()`; `writeShadowFile`), `src/telemetry/index.ts` (`recordScore?`)
- Modify: `src/cli/index.ts`, `src/core/modalities/explore.ts` (`--decider-shadow`)
- Test: `tests/unit/decider-config.test.ts`, `tests/unit/decider.test.ts`, `tests/unit/cli-modalities.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ShadowEntry {
    use: DeciderUse;
    /** What the decider was shown (the redacted state, or a compact description of it). */
    input: unknown;
    /** What the current path decided. */
    current: unknown;
    /** What the decider would have decided (or `{ unavailable: reason }`). */
    decider: unknown;
    confidence?: number;
    latencyMs: number;
    /** 1/0 when the current path makes a comparable decision; absent otherwise (repair-triage: spec §9.3). */
    agreement?: 0 | 1;
  }
  export interface ShadowLog { readonly entries: readonly ShadowEntry[]; record(e: ShadowEntry): void }
  export interface DeciderSummary { provider: DeciderProvider; model: string; calls: number; fallbacks: { use: DeciderUse; reason: string }[] }
  // Decider gains:  readonly shadow?: ShadowLog;  summary(): DeciderSummary;
  // DeciderConfig gains: shadow: boolean;
  export function writeShadowFile(runDir: string, decider: Decider | undefined): Promise<void>; // no-op unless shadow
  ```
- Behavior: in shadow mode `makeDecider` meters into a **private** `CostLedger` (so `report.json.cost` stays byte-identical) and `writeShadowFile` writes `runs/<id>/decider-shadow.json` = `{ provider, model, minConfidence, calls, fallbacks, cost, entries }`. `record()` forwards `agreement` to `telemetry.recordScore("decider.<use>.agreement", 0|1)`.
- Tests: `DECIDER_SHADOW=1` without `DECIDER` → error "needs a provider"; `--decider-shadow` → `CAIRN_DECIDER_SHADOW`; shadow decider's calls do not appear in the passed ledger; `summary().fallbacks` lists each unavailable call with its reason; `writeShadowFile(dir, undefined)` writes nothing; explore flags 20.
- [ ] Steps: failing tests → implement → pass → snapshot `-u` + numstat check → commit `feat(decider): shadow mode — record decisions next to the current path, change nothing`.

### Task 9: `repair-triage` (§6.1)

**Files:**
- Create: `src/decider/uses/repair-triage.ts`
- Modify: `src/agent/repair-loop.ts`
- Test: `tests/unit/decider-repair-triage.test.ts`, `tests/unit/repair-loop.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export const FAILURE_CATEGORIES: Record<FailureCategory, string>; // label → description sent as the choice criteria
  export type FailureCategory = "locator-ambiguous" | "locator-missing" | "timing" | "wrong-assertion" | "app-bug" | "env-or-session";
  export interface TriageResult { test: string; category: FailureCategory; confidence: number; exclude: boolean }
  export function triageState(r: TestResult, maxChars: number): string; // "Playwright test "<name>" failed.\nError:\n<clipped error>"
  export function makeTriage(decider: Decider): (failed: TestResult[]) => Promise<TriageResult[]>;
  // repair-loop.ts
  export function failedTestsHint(results: TestResult[], triage?: ReadonlyMap<string, TriageResult>): string; // unchanged output when triage is absent/empty
  RepairLoopDeps.triage?: (failed: TestResult[]) => Promise<TriageResult[]>;
  RepairLoopResult.notRepaired?: TriageResult[]; // key absent unless something was excluded
  ```
- Rules (spec §6.1): one `choice` per failed test (its own state); only a confident answer counts (`confidence ≥ minConfidence`); `app-bug`/`env-or-session` → `exclude: true` (left out of the hint, reported); other categories → ` [triage: <category>]` after the test name in the hint; unavailable or below threshold → the test goes into the hint exactly as today; everything excluded → leave the loop **before** `attempts += 1`; a test excluded once stays excluded (no second decider call); keep-best and no-progress untouched. Shadow: record `{ use, input: state, current: "repair", decider: { category, confidence, wouldExclude } | { unavailable }, latencyMs }` (no `agreement` — §9.3) and return `[]`.
- **Asymmetry tests (must go red when the guard is removed — verify by deleting the `confidence < minConfidence` line once, watching the test fail, restoring):**
  - `app-bug` at confidence 0.5 (threshold 0.75) → not excluded, no category tag → the hint equals `failedTestsHint(results)` byte for byte.
  - decider throws → `[]`.
- Repair-loop tests: without `triage` every existing test is unchanged; with a triage excluding one of two → the hint omits it and `notRepaired` lists it; excluding all → `attempts === 0`, `generate` called once (the initial), a progress line says so; category tag present for a confident `timing`.
- [ ] Steps: failing tests → implement → pass → commit `feat(decider): repair-triage — keep app bugs and broken environments out of repair`.

### Task 10: `coverage` (§6.2)

**Files:**
- Create: `src/decider/uses/coverage.ts`
- Modify: `src/eval/judge.ts` (add `checklistCoverageScore`)
- Test: `tests/unit/decider-coverage.test.ts`, `tests/unit/judge.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export function caseState(tc: TestCase): string; // title, steps, expected — NOT clipped: an over-long case is refused by caps → fallback
  export function deciderChecklistCoverage(items: { text: string }[], cases: TestCase[], decider: Decider):
    Promise<{ value: number; comment: string; perItem: { item: string; covered: boolean }[] } | undefined>;
  // eval/judge.ts
  export function checklistCoverageScore(items: ChecklistItem[], cases: TestCase[],
    judge: () => Promise<{ value: number; comment: string }>, decider?: Decider): Promise<Score>;
  ```
- Rules: per case one call (state = the case), one `noul` per checklist item (chunked by `caps.maxQuestionsPerCall`), `criteria: { true: "Its steps or expected result exercise this checklist item", false: "It does not exercise this checklist item" }`; an item is covered iff some case answers yes with `confidence ≥ minConfidence`; if any item has no confident yes AND at least one unconfident answer → `undefined` (the LLM judge decides); any unavailable call → `undefined`. `checklistCoverageScore`: decider result (active mode) → else `judge()` → else token `coverageScore` — **exactly** today's objects `{ name, value, comment }` / `{ name, value }` when the decider is absent (byte-identical `report.json`). Shadow: current = judge/token result; record `{ input: { items, cases: n }, current: value, decider: perItem | { unavailable }, agreement: |Δvalue| ≤ 0.1 ? 1 : 0 }`.
- Tests: matrix happy path; confident-no everywhere → uncovered; an uncertain item → `undefined`; unavailable → `undefined`; `checklistCoverageScore` without decider calls `judge` once and returns the identical object; judge throws → token object without `comment` (as today); shadow returns the judge's score and records agreement.
- [ ] Steps: failing tests → implement → pass → commit `feat(decider): checklist coverage by decider, judge as fallback`.

### Task 11: Wiring — explore, design, automate, report

**Files:**
- Modify: `src/agent/graph.ts` (`ExploreDeps.decider?: Decider`; triage into `runRepairLoop` when `uses.has("repair-triage")`; `ExploreOutcome.notRepaired?`)
- Modify: `src/agent/index.ts` (`makeDecider` per run with `router.ledger`, `telemetry`, `secretValues(knowledgeText, process.env)`, `onProgress` as `warn`; coverage via `checklistCoverageScore`; `report.json` gains `...(decider && !decider.shadow ? { decider: decider.summary() } : {})` and `...(notRepaired?.length ? { notRepaired } : {})`; `writeShadowFile(runWriter.dir, decider)` after the report; same in `runDesign` (coverage only) and `runAutomate` (triage; `AutomateResult.notRepaired?`))
- Modify: `src/artifacts/report.ts` (`ReportInput.notRepaired?`, `ReportInput.decider?` → sections "Not repaired — likely app bug / environment" and "Decision layer" rendered only when present)
- Modify: `src/cli/index.ts` (automate prints not-repaired lines)
- Test: `tests/unit/report.test.ts` (sections absent without the keys — byte-identical `report.md`), `tests/unit/explore-graph.test.ts` (graph passes triage only when enabled)
- [ ] Steps: failing tests → implement → pass → commit `feat(decider): wire triage and coverage into explore, design and automate`.

### Task 12: Integration tests, docs — gate, PR, merge

**Files:**
- Create: `tests/integration/decider-runs.test.ts`
- Modify: `docs/configuration.md`, `CHANGELOG.md`, ADR-0022 (shadow section final)

- [ ] **Byte-identical test** (§10): fixture site via `startFixtureServer()` + the real lib gateway; LLM invokes are recording fakes (every prompt text captured); `validate` scripted (attempt 0: one failure with a Playwright error, attempt 1: green); a real `ArtifactStore` in `runs/.itest-decider/<variant>`. Variants: (A) no decider, (B) `makeDecider(parseDeciderConfig(DECIDER=off))` → `undefined`, (C) shadow with a fake Jev server. Assert: captured prompts A == B == C; every file under the run dir A == C except `decider-shadow.json`; C has `decider-shadow.json` with ≥ 1 `repair-triage` entry.
- [ ] **Dead decider test**: a `node:http` server answering 500 to every `POST /v1/systemone`; active mode; the graph completes, the hint equals variant A's, `decider.summary().fallbacks.length > 0`, every fallback reason `HTTP 500`.
- [ ] Gate (build · lint · test:coverage, numbers checked) → push → PR → CI → merge.

---

# PR 3 — Laya (branch `docs/decider-laya`)

### Task 13: Laya server docs + verification on the multilingual checkpoint

**Files:**
- Create: `docs/decider.md`
- Modify: `README.md` (one Documentation line), `docs/langfuse.md` (spans `decider.<use>`, scores `decider.<use>.confidence` / `.agreement`), `docs/mcp.md` (`decider` parameter), `docs/architecture/overview.md` (replace "(For now) not a crawler — single page" with the `--flow` reality + a decider paragraph), `CHANGELOG.md`

- [ ] **`docs/decider.md`**: what it is (and is not — no generation, no Pilot); when to enable and when not; Jev vs Laya (data destination, cost, caps, language); running Laya (`pip install laya` → `laya-serve`, `LAYA_API_KEY`, `LAYA_HOST`, `LAYA_PORT`, `LAYA_MODELS`, `GET /health`; `DECIDER_MODEL=multilingual` for non-English apps); shadow mode and the pilot (§9); the asymmetry; confidence ≠ probability of being right; the measured laya behaviors. No Jev performance numbers (§8.3).
- [ ] **Verification (acceptance PR 3)**, real runs against `tests/fixtures/site` served locally, laya-serve on `127.0.0.1:8000`:
  1. `DECIDER=laya DECIDER_BASE_URL=… DECIDER_MODEL=multilingual QA_TESTCASE_LANG=Ukrainian cairn explore --url <site> --checklist <uk checklist> --decider-shadow` → completes; `decider-shadow.json` present; `report.json` has no `decider` key.
  2. Same without shadow → completes; `report.json.decider` shows calls/fallbacks; coverage decided or fallen back, never an error.
  3. Caps: a checklist whose case text exceeds 1 200 chars → fallback recorded, run completes.
  Record the outcomes (numbers, not adjectives) in the PR body.
- [ ] `.env.example` — **operator step** (the path is denied to the agent by the project's permission rules): add the `DECIDER*` block from `docs/configuration.md`.
- [ ] Gate → PR → merge.

---

# PR 4 — `locator-heal` v1 (branch `feat/decider-locator-heal`)

### Task 14: Broken-locator parsing and candidate filtering (pure)

**Files:**
- Create: `src/decider/uses/locator-heal.ts` (pure part)
- Modify: `src/flow/crawl.ts` (`export const DESTRUCTIVE`), `src/decider/types.ts` (`DECIDER_USES` += `"locator-heal"`), `src/config/index.ts` (`locator-heal` requires `repair-triage` → error)
- Test: `tests/unit/locator-heal.test.ts`, `tests/unit/decider-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BrokenLocator { role: string; name?: string; source: string } // source = the getByRole(...) text as it appeared
  export function parseBrokenLocator(error: string): BrokenLocator | undefined; // getByRole('x', { name: 'y'[, exact: true] }) with ' or "
  export function compatibleRoles(role: string): ReadonlySet<string>; // same role, plus {textbox,searchbox,combobox}, {checkbox,switch}, {menuitem,menuitemcheckbox,menuitemradio}
  export function healCandidates(aria: string, broken: BrokenLocator): ElementRef[]; // interactive, named, compatible role, NOT DESTRUCTIVE, NOT isDeletionIntent, dedup by role+name
  export function locatorText(el: { role: string; name: string }): string; // getByRole('button', { name: 'Save', exact: true })
  ```
- **Asymmetry tests (red when the filter is removed):** a destructive `button "Delete account"` and an incompatible `link "Save"` are never among the candidates for a broken `getByRole('button', { name: 'Sav' })`.
- [ ] Steps: failing tests → implement → pass → commit.

### Task 15: The healer — decide, verify, propose

**Files:** Modify `src/decider/uses/locator-heal.ts`; Test `tests/unit/locator-heal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HealRecord { test: string; from: string; to: string; confidence: number }
  export function makeHeal(opts: { decider: Decider; gateway: BrowserGateway; url: string }):
    (failure: TestResult, triage: TriageResult) => Promise<HealRecord | undefined>;
  ```
- Flow (§6.6): only for triage `locator-missing`/`locator-ambiguous`; parse the broken locator (no parse → none); `gateway.observe({ url })` → `healCandidates`; none → none. Candidates `c1..cN` + `none-of-these`. `N + 1 ≤ caps.maxOptions` → one `choice`; else two-stage: one `score` per candidate (levels "Unrelated to the failing step" / "Plausible" / "Clearly the element the step meant", chunked by `maxQuestionsPerCall`), top 10 → `choice` + `none-of-these`. `none-of-these` or `confidence < minConfidence` → none. The chosen candidate goes through `gateway.verify([candidate])` → `count === 1` or none. Result: `{ from: broken.source, to: locatorText(chosen), confidence }`. Any `DeciderUnavailable` → none. Shadow: record, return none.
- Tests (§10): without a triage category → never runs; `none-of-these` → none; `verify` count 2 → refused; two-stage path taken when `caps.maxOptions ≤ 20` and candidates > 19; the decider never receives a destructive/incompatible option.
- [ ] Steps: failing tests → implement → pass → commit.

### Task 16: Wiring heal into repair, and the report

**Files:** `src/agent/repair-loop.ts` (`RepairLoopDeps.heal?`; a healed test's hint line gains ` → replace <from> with <to> (verified: 1 match)`; `RepairLoopResult.healed?`), `src/agent/graph.ts` (heal when `uses.has("locator-heal")`, gateway + url), `src/agent/index.ts` (`report.json.healed`; automate: a lazily created gateway for heal, closed at the end), `src/artifacts/report.ts` ("Locators healed" section: from → to, confidence)
- Tests: repair-loop with heal (proposal in hint; `healed` recorded); report renders the section only when present.
- [ ] Steps: failing tests → implement → pass → commit.

### Task 17: Acceptance on the fixture site; open question 6 — gate, PR, merge

- [ ] **Acceptance (§12 PR 4)**: a design run dir whose `testcases/ATC-*.md` carries a deliberately broken selector (`getByRole('button', { name: 'Sign' })` for "Sign in"); `cairn automate --run <dir> --validate --decider laya` (+ `DECIDER_USES=repair-triage,locator-heal`) → the first validation fails, triage `locator-missing`, heal proposes `Sign in` verified 1 match, repair converges in **1** attempt, `healed` is reported; the same without `--decider` → the repair loop behaves as before.
- [ ] **Open question 6**: run one failing spec through `runSpecs` and check whether Playwright 1.60's JSON reporter carries an `error-context` attachment (page snapshot at failure). Record the answer in ADR-0022; if present, file it as the v2 path (candidates from the failure-time snapshot) — not implemented in v1.
- [ ] Docs (`docs/decider.md`, ADR-0022, CHANGELOG) → gate → PR → merge.

---

## Operator follow-ups (not code)

- `.env.example`: add the `DECIDER*` block (denied path for the agent).
- A real TypeSafe key for one `cairn doctor` with `DECIDER=jev` against the real cloud (optional; the protocol is already verified against laya-serve and the official SDK models).
- The pilot (§9): 20–30 shadow runs on 3+ apps, hand-labelled triage, per-use thresholds — the gate for PR 5/6.
- §8.5: the TypeSafe terms on publishing performance data — the owner's call before any Jev number appears in docs or bench.
