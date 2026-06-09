# Data Contracts (zod schemas)

All cross-module data is typed via zod (pin `~3.25.67`, Spike S1) — a single source of truth for both
TS types and the LLM structured output. Below are **sketches**; the final schemas live in the corresponding modules
and are extended over sprints S1–S5.

## PageStudy / ElementRef (Sprint 1)

```ts
export const ElementRefSchema = z.object({
  ref: z.string(),                       // stable id (@e1, @e2…) for act()
  role: z.string(),                      // ARIA role (button, textbox, link…)
  name: z.string().optional(),           // accessible name
  selectorHint: z.string().optional(),   // hint for getBy* during codegen
  interactive: z.boolean(),
  rank: z.number(),                      // importance for testing
});

export const PageStudySchema = z.object({
  url: z.string().url(),
  screenshotB64: z.string(),             // base64 PNG (for vision)
  ariaYaml: z.string(),                  // ariaSnapshot() output
  elements: z.array(ElementRefSchema),
  capturedBy: z.enum(["lib", "cli"]),
});
export type PageStudy = z.infer<typeof PageStudySchema>;
```

## TestCase (Sprint 2)

```ts
export const TestCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  technique: z.enum([                    // ISO/IEC/IEEE 29119-4 techniques
    "equivalence-partitioning", "boundary-value", "decision-table",
    "state-transition", "exploratory", "error-guessing",
  ]),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(z.string()),
  expected: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  elementRefs: z.array(z.string()),      // binding to ElementRef.ref (grounding!)
});
export type TestCase = z.infer<typeof TestCaseSchema>;
```

## Checklist (Sprint 4)

```ts
export const ChecklistItemSchema = z.object({
  id: z.string(),
  intent: z.string(),                    // what to check
  area: z.string().optional(),           // UI area
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});
export const ChecklistSchema = z.object({
  source: z.string(),                    // path/hash for tracing
  items: z.array(ChecklistItemSchema),
});
export type Checklist = z.infer<typeof ChecklistSchema>;
```

## GeneratedSuite (Sprint 3)

```ts
export const FileBlobSchema = z.object({
  path: z.string(),                      // relative path under runs/<id>/tests
  content: z.string(),
});
export const GeneratedSuiteSchema = z.object({
  files: z.array(FileBlobSchema),        // page objects, fixtures, *.spec.ts
  ariaSnapshots: z.array(FileBlobSchema),// sidecar *.aria.yml
  pageObjects: z.array(z.string()).default([]),
});
export type GeneratedSuite = z.infer<typeof GeneratedSuiteSchema>;
```

## ValidationReport (Sprint 3)

```ts
export const TestResultSchema = z.object({
  test: z.string(),
  status: z.enum(["passed", "failed", "flaky"]),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});
export const ValidationReportSchema = z.object({
  results: z.array(TestResultSchema),
  greenRatio: z.number(),                // 0..1 → runs_green score
  flakyCount: z.number(),
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
```

## Score (Sprint 5)

```ts
export const ScoreSchema = z.object({
  name: z.string(),                      // compiles, runs_green, grounding…
  value: z.number(),                     // 0..1 (normalized)
  dataType: z.enum(["NUMERIC", "BOOLEAN", "CATEGORICAL"]).default("NUMERIC"),
  comment: z.string().optional(),
  source: z.enum(["deterministic", "llm-judge"]),
});
export type Score = z.infer<typeof ScoreSchema>;
```

## ModelsConfig / providers (Config, Sprint 0) — ADR-0002

```ts
export const ProviderSchema = z.enum(["anthropic", "openrouter"]);

export const ModelTierSchema = z.object({
  provider: ProviderSchema,
  model: z.string(),                     // e.g. "claude-opus-4-8" | "deepseek/deepseek-r1"
  supportsVision: z.boolean().default(false),
  temperature: z.number().optional(),    // ignored where the provider doesn't support it
});

export const ModelsConfigSchema = z.object({
  reasoning: ModelTierSchema,            // designTestCases (+ identifyElements if vision)
  bulk: ModelTierSchema,                 // generateCode
  judge: ModelTierSchema,                // LLM-as-judge (SDK-side)
  vision: ModelTierSchema.optional(),    // separate, if reasoning has no vision → aria-only fallback
});
// The profile (anthropic|openrouter|mixed) is just a way of filling these fields in AppConfig.
```

`makeModel(tier)` reads `ModelsConfig` and returns a `BaseChatModel`: `ChatAnthropic` or `ChatOpenAI`
(with `configuration.baseURL = OpenRouter`). `supportsVision` controls the `identifyElements` mode.

> Keep this file in sync with the real schemas in the code. When a schema changes — update it here and in
> [`traceability.md`](../traceability.md).
