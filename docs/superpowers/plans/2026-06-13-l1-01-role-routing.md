# L1-01 — Per-Role Model Routing + Per-Run Cost/Token Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin named-role layer (`worker`/`reasoner`) over the existing 4-tier `makeModel(tier)` map, plus per-role cost+token reporting captured from each LangChain response — backward-compatible with `LLM_PROFILE`.

**Architecture:** Roles resolve to a tier (override `cfg.roles[role]` ?? the profile/tier default). A `RoleRouter` (sibling to `CallBudget`, one per run) builds per-step metered invokers; a `CostLedger` accumulates usage→cost per role. Node logic and the graph are unchanged — nodes still receive a `StructuredInvoke`. Pilot verdict moves from the cheap `judge` tier to `reasoner` (intended behavior change). A `volume` routing preset routes `worker`→cheap OpenRouter + `reasoner`→Anthropic.

**Tech Stack:** Node 20+, TypeScript strict (NodeNext, `noUncheckedIndexedAccess`), LangChain (`@langchain/{anthropic,openai,core}`), zod 4, vitest. NOT the Vercel AI SDK.

---

## Role → tier mapping (the contract)

| Step | Calls LLM? | Role | Default tier (no routing) | `anthropic` model |
|---|---|---|---|---|
| observe (capture) | no | — | — | — |
| identifyElements (analyzePage) | yes | `worker` | `vision ?? reasoning` | Haiku |
| verifyLocators / exploreStates / probeInteractions | no | — | — | — |
| designTestCases | yes | `reasoner` | `reasoning` | Opus |
| generateCode | yes | `worker` | `bulk` | Sonnet |
| validate | no | — | — | — |
| repair (regenerate) | yes | `worker` | `bulk` | Sonnet |
| judgeTestCases / judgeChecklistCoverage | yes | `judge`* | `judge` (unchanged) | Haiku |
| pilotReview (Pilot verdict) | yes | `reasoner` | `reasoning` **(was `judge`)** | Opus **(was Haiku)** |

\* `judge` is metered-only (cost visibility) — it is the cheap LLM-as-judge scorer and stays on `cfg.models.judge`; it is NOT a routable role. Only `worker` and `reasoner` accept overrides/presets. This avoids the name clash called out in issue #6 delta #2.

**Default pricing (USD / 1M tokens), source = claude-api skill:** Opus 4.8 `5/25`, Sonnet 4.6 `3/15`, Haiku 4.5 `1/5`. OpenRouter models: approximate, movable (ADR-0002); any model absent from the table → cost `null` (tokens still counted).

---

### Task 1: Config schema — Role types + RolesConfig + AppConfig.roles

**Files:**
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Add role types + routing config to schema.ts** (after `ModelsConfigSchema`)

```ts
/** Named role over the tier map (L1-01). Only these two are routable. */
export const RoleSchema = z.enum(["worker", "reasoner"]);
export type Role = z.infer<typeof RoleSchema>;

/** A role override reuses the tier shape (provider + model + vision + temperature). */
export type RoleModel = ModelTier;

/** Optional per-role routing overrides, layered over `models` (the tier map). */
export type RolesConfig = Partial<Record<Role, RoleModel>>;
```

- [ ] **Step 2: Add `roles?` to `AppConfig`** (optional, additive — backward-compatible)

```ts
  /** L1-01 per-role routing overrides (optional; layered over `models`). */
  roles?: RolesConfig;
```

- [ ] **Step 3: build** — `npm run build` passes (no callers yet).

---

### Task 2: Routing presets (volume)

**Files:**
- Modify: `src/config/profiles.ts`

- [ ] **Step 1: Add `ROUTING_PRESETS` with `volume`** (cheap OpenRouter worker + Anthropic reasoner)

```ts
import type { LlmProfile, ModelsConfig, RolesConfig } from "./schema.js";

/** Named role-routing presets (L1-01). `volume` = cheap worker + smart reasoner (Explorbot-style). */
export const ROUTING_PRESETS: Record<string, RolesConfig> = {
  volume: {
    // worker spans identifyElements(vision) + generateCode/repair(bulk) → one cheap text model.
    // supportsVision:false → identifyElements falls back to aria-only (ADR-0002 vision-optional).
    worker: { provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false },
    // reasoner = designTestCases + Pilot verdict → quality model.
    reasoner: { provider: "anthropic", model: "claude-opus-4-8", supportsVision: false },
  },
};
```

---

### Task 3: Cost module — pricing, usage extraction, ledger, report types

**Files:**
- Create: `src/llm/cost.ts`
- Test: `tests/unit/cost.test.ts`
- Modify: `vitest.config.ts` (add `src/llm/cost.ts` to coverage `include`)

- [ ] **Step 1: Write the failing test** `tests/unit/cost.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { CostLedger, extractUsage, priceFor, DEFAULT_PRICING } from "../../src/llm/cost.js";

const PRICES = { "m-cheap": { inputPer1M: 1, outputPer1M: 2 }, "m-pricey": { inputPer1M: 10, outputPer1M: 30 } };

describe("priceFor", () => {
  it("known model → price; unknown → undefined", () => {
    expect(priceFor("m-cheap", PRICES)).toEqual({ inputPer1M: 1, outputPer1M: 2 });
    expect(priceFor("nope", PRICES)).toBeUndefined();
  });
  it("default table prices the Anthropic profile models", () => {
    expect(priceFor("claude-opus-4-8", DEFAULT_PRICING)).toEqual({ inputPer1M: 5, outputPer1M: 25 });
  });
});

describe("extractUsage", () => {
  it("reads usage_metadata", () => {
    expect(extractUsage({ usage_metadata: { input_tokens: 100, output_tokens: 40 } })).toEqual({ inputTokens: 100, outputTokens: 40 });
  });
  it("falls back to response_metadata.usage (OpenAI shape)", () => {
    expect(extractUsage({ response_metadata: { usage: { prompt_tokens: 7, completion_tokens: 3 } } })).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
  it("missing usage → zeros (never throws)", () => {
    expect(extractUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("CostLedger — per-role attribution sums correctly", () => {
  it("sums tokens + cost per role across calls", () => {
    const led = new CostLedger(PRICES);
    led.record("worker", "m-cheap", { inputTokens: 1_000_000, outputTokens: 500_000 }); // 1*1 + 0.5*2 = 2
    led.record("worker", "m-cheap", { inputTokens: 1_000_000, outputTokens: 0 });        // +1 = 3
    led.record("reasoner", "m-pricey", { inputTokens: 100_000, outputTokens: 100_000 }); // 0.1*10 + 0.1*30 = 4
    const rep = led.report();
    const worker = rep.perRole.find((r) => r.role === "worker")!;
    expect(worker.calls).toBe(2);
    expect(worker.inputTokens).toBe(2_000_000);
    expect(worker.outputTokens).toBe(500_000);
    expect(worker.costUsd).toBeCloseTo(3, 6);
    const reasoner = rep.perRole.find((r) => r.role === "reasoner")!;
    expect(reasoner.costUsd).toBeCloseTo(4, 6);
    expect(rep.totalTokens).toBe(2_700_000);
    expect(rep.totalCostUsd).toBeCloseTo(7, 6);
  });
  it("unknown model price → role costUsd null + total null, tokens still counted", () => {
    const led = new CostLedger(PRICES);
    led.record("worker", "mystery/model", { inputTokens: 1000, outputTokens: 1000 });
    const rep = led.report();
    const worker = rep.perRole.find((r) => r.role === "worker")!;
    expect(worker.costUsd).toBeNull();
    expect(worker.inputTokens).toBe(1000);
    expect(rep.totalCostUsd).toBeNull();
    expect(rep.totalTokens).toBe(2000);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`cost.ts` missing): `npm test -- cost`

- [ ] **Step 3: Implement** `src/llm/cost.ts`

```ts
/** Per-role cost + token accounting (L1-01). Pure — no SDK, no network. */

export interface TokenUsage { inputTokens: number; outputTokens: number; }
export interface ModelPrice { inputPer1M: number; outputPer1M: number; }

/**
 * Default price table (USD per 1M tokens). Anthropic prices are authoritative
 * (claude-api skill, 2026-06). OpenRouter prices are APPROXIMATE and move
 * (ADR-0002) — any model absent here yields a null (unknown) cost; tokens are
 * still counted. Override by passing a table to CostLedger.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5 },
  // OpenRouter — approximate, movable (ADR-0002).
  "deepseek/deepseek-chat": { inputPer1M: 0.28, outputPer1M: 0.88 },
  "deepseek/deepseek-r1": { inputPer1M: 0.55, outputPer1M: 2.19 },
  "qwen/qwen-2.5-72b-instruct": { inputPer1M: 0.35, outputPer1M: 0.4 },
  "qwen/qwen-2-vl-72b-instruct": { inputPer1M: 0.4, outputPer1M: 0.4 },
};

export function priceFor(model: string, table: Record<string, ModelPrice> = DEFAULT_PRICING): ModelPrice | undefined {
  return table[model];
}

/** Minimal structural view of a LangChain response carrying usage. */
interface UsageCarrier {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
  response_metadata?: {
    usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    tokenUsage?: { promptTokens?: number; completionTokens?: number };
  };
}

/** Read token usage off a LangChain message; never throws (missing → zeros). */
export function extractUsage(raw: unknown): TokenUsage {
  const m = (raw ?? {}) as UsageCarrier;
  const um = m.usage_metadata;
  if (um && (um.input_tokens !== undefined || um.output_tokens !== undefined)) {
    return { inputTokens: um.input_tokens ?? 0, outputTokens: um.output_tokens ?? 0 };
  }
  const u = m.response_metadata?.usage;
  if (u) {
    return {
      inputTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
      outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
    };
  }
  const t = m.response_metadata?.tokenUsage;
  if (t) return { inputTokens: t.promptTokens ?? 0, outputTokens: t.completionTokens ?? 0 };
  return { inputTokens: 0, outputTokens: 0 };
}

export interface RoleCost {
  role: string;
  models: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null; // null if any contributing model has no price
}
export interface CostReport {
  perRole: RoleCost[];
  totalTokens: number;
  totalCostUsd: number | null;
}

interface Row { models: Set<string>; calls: number; in: number; out: number; cost: number; costKnown: boolean; }

/** Accumulates usage per role and prices it. Sibling to CallBudget; one per run. */
export class CostLedger {
  private readonly rows = new Map<string, Row>();
  constructor(private readonly pricing: Record<string, ModelPrice> = DEFAULT_PRICING) {}

  record(role: string, model: string, usage: TokenUsage): void {
    const row = this.rows.get(role) ?? { models: new Set(), calls: 0, in: 0, out: 0, cost: 0, costKnown: true };
    row.calls += 1;
    row.in += usage.inputTokens;
    row.out += usage.outputTokens;
    row.models.add(model);
    const p = this.pricing[model];
    if (p) row.cost += (usage.inputTokens / 1e6) * p.inputPer1M + (usage.outputTokens / 1e6) * p.outputPer1M;
    else row.costKnown = false;
    this.rows.set(role, row);
  }

  report(): CostReport {
    const order = ["worker", "reasoner", "judge"];
    const roles = [...this.rows.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    const perRole: RoleCost[] = roles.map((role) => {
      const r = this.rows.get(role)!;
      return {
        role,
        models: [...r.models],
        calls: r.calls,
        inputTokens: r.in,
        outputTokens: r.out,
        totalTokens: r.in + r.out,
        costUsd: r.costKnown ? Number(r.cost.toFixed(6)) : null,
      };
    });
    const totalTokens = perRole.reduce((s, r) => s + r.totalTokens, 0);
    const anyUnknown = perRole.some((r) => r.costUsd === null);
    const totalCostUsd = anyUnknown ? null : Number(perRole.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(6));
    return { perRole, totalTokens, totalCostUsd };
  }
}
```

- [ ] **Step 4: Add to coverage gate** — in `vitest.config.ts` `coverage.include`, add `"src/llm/cost.ts",`.

- [ ] **Step 5: Run — expect PASS**: `npm test -- cost`

---

### Task 4: Metered invoker (captures usage off the LangChain response)

**Files:**
- Modify: `src/llm/structured.ts` (gated — must stay ≥80%)
- Test: `tests/unit/routing.test.ts` (shared with Task 5)

- [ ] **Step 1: Write the failing test** (in `tests/unit/routing.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { meteredInvoker } from "../../src/llm/structured.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

function fakeModel(parsed: unknown, raw: unknown): BaseChatModel {
  return { withStructuredOutput: () => ({ invoke: async () => ({ raw, parsed }) }) } as unknown as BaseChatModel;
}

describe("meteredInvoker", () => {
  it("returns parsed result AND reports usage to the callback", async () => {
    const seen: Array<{ usage: unknown; model: string }> = [];
    const model = fakeModel({ ok: 1 }, { usage_metadata: { input_tokens: 12, output_tokens: 5 } });
    const invoke = meteredInvoker(model, (usage, m) => seen.push({ usage, model: m }), "deepseek/deepseek-chat");
    const out = await invoke(z.object({ ok: z.number() }), []);
    expect(out).toEqual({ ok: 1 });
    expect(seen).toEqual([{ usage: { inputTokens: 12, outputTokens: 5 }, model: "deepseek/deepseek-chat" }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npm test -- routing`

- [ ] **Step 3: Implement** in `src/llm/structured.ts` (add import + function; keep existing exports)

```ts
import { extractUsage, type TokenUsage } from "./cost.js";
// ...existing imports & code stay...

/**
 * Like structuredInvoker, but captures usage off the raw LangChain response
 * (via withStructuredOutput includeRaw) and reports it to `onUsage` (L1-01).
 * Node logic is unchanged — it still receives the parsed result.
 */
export function meteredInvoker(
  model: BaseChatModel,
  onUsage: (usage: TokenUsage, model: string) => void,
  modelId: string,
): StructuredInvoke {
  return async <T>(schema: ZodType<T>, messages: BaseMessageLike[]): Promise<T> => {
    const structured = model.withStructuredOutput(schema, { includeRaw: true });
    const res = (await structured.invoke(messages)) as { raw: unknown; parsed: T };
    try {
      onUsage(extractUsage(res.raw), modelId);
    } catch {
      // metering must never break the call
    }
    return res.parsed;
  };
}
```

- [ ] **Step 4: Run — expect PASS**: `npm test -- routing`

---

### Task 5: Routing layer — resolveRoleTier + RoleRouter

**Files:**
- Create: `src/llm/routing.ts`
- Test: `tests/unit/routing.test.ts` (extend)

- [ ] **Step 1: Add failing tests** (append to `tests/unit/routing.test.ts`)

```ts
import { resolveRoleTier, RoleRouter, KNOWN_ROLES } from "../../src/llm/routing.js";
import type { ModelTier } from "../../src/config/index.js";

const vision: ModelTier = { provider: "anthropic", model: "claude-haiku-4-5", supportsVision: true };
const bulk: ModelTier = { provider: "anthropic", model: "claude-sonnet-4-6", supportsVision: false };

describe("resolveRoleTier — override ?? fallback (backward-compat)", () => {
  it("no routing → returns the fallback tier unchanged", () => {
    expect(resolveRoleTier("worker", vision, undefined)).toBe(vision);
  });
  it("override present → returns the override tier", () => {
    const ovr: ModelTier = { provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false };
    expect(resolveRoleTier("worker", vision, { worker: ovr })).toBe(ovr);
  });
  it("KNOWN_ROLES is worker + reasoner only", () => {
    expect([...KNOWN_ROLES]).toEqual(["worker", "reasoner"]);
  });
});

describe("RoleRouter — meters per role, falls back per tier", () => {
  it("invoke meters usage under the role; tierFor resolves override", async () => {
    const keys = { anthropicApiKey: "k" };
    const fakeModel = () => ({ withStructuredOutput: () => ({ invoke: async () => ({ raw: { usage_metadata: { input_tokens: 4, output_tokens: 2 } }, parsed: { ok: 1 } }) }) });
    const cfg = { models: { reasoning: bulk, bulk, judge: bulk, vision }, roles: { worker: { provider: "openrouter", model: "x", supportsVision: false } } } as never;
    const router = new RoleRouter(cfg, keys, { charge() {} } as never, undefined, fakeModel as never);
    expect(router.tierFor("worker", vision).model).toBe("x");
    const inv = router.invoke("reasoner", bulk);
    await inv((await import("zod")).z.object({ ok: (await import("zod")).z.number() }), []);
    const rep = router.ledger.report();
    expect(rep.perRole.find((r) => r.role === "reasoner")?.inputTokens).toBe(4);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npm test -- routing`

- [ ] **Step 3: Implement** `src/llm/routing.ts`

```ts
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig, ModelTier, RolesConfig } from "../config/index.js";
import { makeModel, type ProviderKeys } from "./factory.js";
import { meteredInvoker, cappedInvoke, retryInvoke, type CallBudget, type StructuredInvoke } from "./structured.js";
import { CostLedger, type ModelPrice } from "./cost.js";

/** Routable roles (L1-01). `judge` is metered-only, NOT routable (cheap scorer stays put). */
export const KNOWN_ROLES = ["worker", "reasoner"] as const;

/** Pure: which tier does this role use? override (roles[role]) ?? fallback. */
export function resolveRoleTier(role: string, fallback: ModelTier, roles: RolesConfig | undefined): ModelTier {
  return (roles?.[role as (typeof KNOWN_ROLES)[number]] as ModelTier | undefined) ?? fallback;
}

type ModelFactory = (tier: ModelTier, keys: ProviderKeys) => BaseChatModel;

/** Builds per-step metered invokers and owns the per-role CostLedger. One per run. */
export class RoleRouter {
  readonly ledger: CostLedger;
  constructor(
    private readonly cfg: AppConfig,
    private readonly keys: ProviderKeys,
    private readonly budget: CallBudget,
    pricing?: Record<string, ModelPrice>,
    private readonly makeModelFn: ModelFactory = makeModel,
  ) {
    this.ledger = new CostLedger(pricing);
  }

  /** Resolved tier for a role (override ?? fallback). */
  tierFor(role: string, fallback: ModelTier): ModelTier {
    return resolveRoleTier(role, fallback, this.cfg.roles);
  }

  /** StructuredInvoke for an already-resolved tier, metered under `role`, capped + retried. */
  invoke(role: string, tier: ModelTier): StructuredInvoke {
    const model = this.makeModelFn(tier, this.keys);
    const metered = meteredInvoker(model, (u, m) => this.ledger.record(role, m, u), tier.model);
    return cappedInvoke(retryInvoke(metered), this.budget);
  }
}
```

- [ ] **Step 4: Export from barrel** `src/llm/index.ts`:

```ts
export { meteredInvoker, structuredInvoker, retryInvoke, CallBudget, cappedInvoke } from "./structured.js";
export { RoleRouter, resolveRoleTier, KNOWN_ROLES } from "./routing.js";
export { CostLedger, DEFAULT_PRICING, priceFor, extractUsage } from "./cost.js";
export type { CostReport, RoleCost, TokenUsage, ModelPrice } from "./cost.js";
```

- [ ] **Step 5: Run — expect PASS**: `npm test -- routing`

---

### Task 6: loadConfig — parse LLM_ROUTING preset + CAIRN_ROLE_* overrides; validate keys; warn unknown

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/unit/config.test.ts` (new)

- [ ] **Step 1: Write failing tests** `tests/unit/config.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../../src/config/index.js";

const base = { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" };

describe("loadConfig — routing is additive + backward-compatible", () => {
  it("no routing config → roles undefined, profile unchanged", () => {
    const cfg = loadConfig({ ...base, LLM_PROFILE: "anthropic" });
    expect(cfg.roles).toBeUndefined();
    expect(cfg.models.reasoning.model).toBe("claude-opus-4-8");
  });
  it("LLM_ROUTING=volume → worker=OpenRouter, reasoner=Anthropic", () => {
    const cfg = loadConfig({ ...base, LLM_ROUTING: "volume" });
    expect(cfg.roles?.worker?.provider).toBe("openrouter");
    expect(cfg.roles?.reasoner?.provider).toBe("anthropic");
  });
  it("missing provider key for a routed role → error names ROLE + PROVIDER", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "a", LLM_ROUTING: "volume" }))
      .toThrow(/Role 'worker'.*OpenRouter/i);
  });
  it("CAIRN_ROLE_WORKER=provider:model overrides the role", () => {
    const cfg = loadConfig({ ...base, CAIRN_ROLE_WORKER: "openrouter:deepseek/deepseek-chat" });
    expect(cfg.roles?.worker).toEqual({ provider: "openrouter", model: "deepseek/deepseek-chat", supportsVision: false });
  });
  it("unknown role in CAIRN_ROLE_* → warning + ignored (falls back to default)", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...base, CAIRN_ROLE_TYPO: "anthropic:claude-opus-4-8" }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown role/i));
    expect(cfg.roles?.["typo" as never]).toBeUndefined();
  });
  it("unknown preset name → warning + no routing (graceful)", () => {
    const warn = vi.fn();
    const cfg = loadConfig({ ...base, LLM_ROUTING: "bogus" }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown.*routing preset/i));
    expect(cfg.roles).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npm test -- config`

- [ ] **Step 3: Implement** in `src/config/index.ts`:
  - import `ROUTING_PRESETS` from `./profiles.js`, `ProviderSchema`, `RoleSchema` from `./schema.js`, re-export `RolesConfig`/`Role`/`ROUTING_PRESETS`.
  - after computing `models`, build `roles` via a new `resolveRoles(read, env, warn)` helper:
    - start from `ROUTING_PRESETS[LLM_ROUTING]` if `LLM_ROUTING` set (unknown name → `warn(...unknown ... routing preset...)`, skip).
    - scan `Object.keys(env)` for `CAIRN_ROLE_<NAME>`: `name=NAME.toLowerCase()`; if `RoleSchema.safeParse(name).success` → parse value `provider:model` (split on first `:`; provider via `ProviderSchema` or throw a clear invalid-provider error; `supportsVision:false`), merge into roles; else `warn(...unknown role '<name>' in CAIRN_ROLE_<NAME> — ignored)`.
    - if no roles collected → return `undefined`.
  - after `roles` resolved, validate provider keys per routed role:

```ts
for (const [role, tier] of Object.entries(roles ?? {})) {
  if (tier.provider === "anthropic" && !anthropicApiKey)
    throw new Error(`Role '${role}' uses Anthropic, but ANTHROPIC_API_KEY is not set.`);
  if (tier.provider === "openrouter" && !openrouterApiKey)
    throw new Error(`Role '${role}' uses OpenRouter, but OPENROUTER_API_KEY is not set.`);
}
```
  - add `roles` to the returned `AppConfig`.

- [ ] **Step 4: Run — expect PASS**: `npm test -- config`

---

### Task 7: Render cost in report.ts (md) + report.json shape

**Files:**
- Modify: `src/artifacts/report.ts`
- Test: `tests/unit/report.test.ts` (extend)

- [ ] **Step 1: Add failing assertion** to the existing `renderReportMd` test — pass a `cost` and assert the section:

```ts
cost: {
  perRole: [
    { role: "worker", models: ["deepseek/deepseek-chat"], calls: 2, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.001 },
    { role: "reasoner", models: ["claude-opus-4-8"], calls: 1, inputTokens: 800, outputTokens: 400, totalTokens: 1200, costUsd: 0.014 },
  ],
  totalTokens: 2700, totalCostUsd: 0.015,
},
// asserts:
expect(md).toContain("Cost (per role)");
expect(md).toContain("worker");
expect(md).toContain("reasoner");
expect(md).toContain("$0.015");
```

- [ ] **Step 2: Implement** — import `CostReport` type, add `cost?: CostReport` to `ReportInput`, render after Metrics:

```ts
if (r.cost && r.cost.perRole.length > 0) {
  lines.push("## Cost (per role)", "", "| role | model(s) | calls | input tok | output tok | cost (USD) |", "|---|---|---|---|---|---|");
  for (const c of r.cost.perRole) {
    lines.push(`| ${c.role} | ${c.models.join(", ")} | ${c.calls} | ${c.inputTokens} | ${c.outputTokens} | ${c.costUsd === null ? "—" : `$${c.costUsd.toFixed(4)}`} |`);
  }
  const total = r.cost.totalCostUsd === null ? "— (some prices unknown)" : `$${r.cost.totalCostUsd.toFixed(4)}`;
  lines.push(`| **total** |  |  |  | ${r.cost.totalTokens} | ${total} |`, "");
}
```

- [ ] **Step 3: Run — expect PASS**: `npm test -- report`

---

### Task 8: Wire RoleRouter into the agent (runExploration / runDesign / runAutomate)

**Files:**
- Modify: `src/agent/index.ts`

No graph change — nodes still get `StructuredInvoke`. Replace each `cappedInvoke(retryInvoke(structuredInvoker(makeModel(<tier>, keys))), budget)` with router-built invokers, compute `useVision` from the resolved worker tier, route Pilot to `reasoner`, and thread cost into results + reports.

- [ ] **Step 1:** In `runExploration`, after `const budget = new CallBudget(80);` add:

```ts
const router = new RoleRouter(cfg, keys, budget);
const visionTier = cfg.models.vision ?? cfg.models.reasoning;
const analyzeTier = router.tierFor("worker", visionTier);
const designTier = router.tierFor("reasoner", cfg.models.reasoning);
const codegenTier = router.tierFor("worker", cfg.models.bulk);
```

- [ ] **Step 2:** Replace the `buildExploreGraph` invoker deps:

```ts
analyzeInvoke: router.invoke("worker", analyzeTier),
designInvoke: router.invoke("reasoner", designTier),
codegenInvoke: router.invoke("worker", codegenTier),
useVision: analyzeTier.supportsVision,
```
(remove the now-duplicate local `visionTier` declaration further down — keep one.)

- [ ] **Step 3:** Replace the judge scorer + checklist coverage invokers with `router.invoke("judge", cfg.models.judge)` (metered under `judge`, tier unchanged). Route **Pilot** to reasoner:

```ts
const pilotTier = router.tierFor("reasoner", cfg.models.reasoning);
pilot = await pilotReview(..., router.invoke("reasoner", pilotTier), prompts);
```

- [ ] **Step 4:** Build `const cost = router.ledger.report();` before writing artifacts. Add `cost` to `writeReport({...})`, to `renderReportMd({...})`, and to the returned `ExploreResult`. Add `cost: CostReport` to the `ExploreResult` interface (import the type).

- [ ] **Step 5:** Apply the same pattern in `runDesign` (analyze/design/codegen + judge; no Pilot) — add `cost` to its `writeReport` + `DesignResult`. In `runAutomate`, route the bulk codegen via `router.invoke("worker", router.tierFor("worker", cfg.models.bulk))` and add `cost?: CostReport` to `AutomateResult`.

- [ ] **Step 6:** `npm run build` — fix type errors. Then `npm test` — existing graph/agent tests still green (deps shape unchanged).

---

### Task 9: Public types + CLI flag + CLI cost print

**Files:**
- Modify: `src/index.ts`, `src/cli/index.ts`

- [ ] **Step 1:** `src/index.ts` — export the cost types:

```ts
export type { CostReport, RoleCost } from "./llm/cost.js";
```

- [ ] **Step 2:** `src/cli/index.ts` — add `--routing <preset>` to `explore`, `design`, `automate`; set `env.LLM_ROUTING = opts.routing` before `loadConfig(env)` (mirror `--backend`). For `explore`/`design` build the env object like `explore` already does.

- [ ] **Step 3:** Print per-role cost in the `explore` summary (after Metrics):

```ts
if (result.cost && result.cost.perRole.length > 0) {
  process.stdout.write("\n=== Cost (per role) ===\n");
  for (const c of result.cost.perRole) {
    const usd = c.costUsd === null ? "n/a" : `$${c.costUsd.toFixed(4)}`;
    process.stdout.write(`  ${c.role.padEnd(9)} ${c.calls} calls  ${c.inputTokens}→${c.outputTokens} tok  ${usd}\n`);
  }
  const total = result.cost.totalCostUsd === null ? "n/a (some prices unknown)" : `$${result.cost.totalCostUsd.toFixed(4)}`;
  process.stdout.write(`  total     ${result.cost.totalTokens} tok  ${total}\n`);
}
```

- [ ] **Step 4:** `npm run build && npm run lint` clean.

---

### Task 10: ADR-0010 + verify + PR

- [ ] **Step 1:** Write `docs/adr/0010-per-role-model-routing.md` (Accepted): role layer over tiers, `worker`/`reasoner` naming (vs the cheap `judge` tier), the Pilot→reasoner behavior change, cost-ledger plumbing, `volume` preset, graceful price handling.
- [ ] **Step 2:** Full gate: `npm run build` · `npm test` · `npm run lint` · `npm run test:coverage` — all green.
- [ ] **Step 3:** Live verification (no Anthropic key in `.env`; OpenRouter present): run `cairn explore` against a public no-auth page with `LLM_PROFILE=openrouter` + a `CAIRN_ROLE_WORKER` OpenRouter override → confirm the summary shows per-role cost + tokens (real tokens). Document that `volume`/`anthropic` live runs need an Anthropic key (config-resolution + key-error covered by unit tests); leave the login-gated DoD line unchecked (ref #27).
- [ ] **Step 4:** Commit on `feat/l1-01-role-routing`; open PR closing #6 with the mapping table, Pilot behavior-change note, backward-compat test result, and the checklist.

---

## Self-review

- **Spec coverage:** roles (T1,T5) · config/env override + fallback (T1,T6) · per-role cost+tokens (T3,T4,T7,T8) · volume preset (T2,T6) · Pilot→reasoner (T8) · all 4 edge-case tests (T6 backward-compat/missing-key/unknown-role + T3 cost-sum). ✓
- **No placeholders:** every step has concrete code or an exact insertion point. ✓
- **Type consistency:** `RoleRouter.tierFor/invoke`, `CostLedger.record/report`, `CostReport`/`RoleCost`, `meteredInvoker(model,onUsage,modelId)`, `extractUsage` used identically across tasks. ✓
