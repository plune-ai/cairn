# Case-quality guardrails (#58) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dedup near-identical test cases (merge the obvious, flag the borderline) and report ISO
29119-4 technique coverage — a meaningful suite, not 50 redundant clicks.

**Architecture:** One deterministic `caseSimilarity(a,b)` verdict drives both `dedupCases` (applied
inside `designTestCases`) and the new `case_redundancy` scorer — a single definition of "near-duplicate".
A `technique_coverage` scorer + a prompt nudge round it out. All in `design/` + `eval/`, behind the seams.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, zod.

## Global Constraints

- Behavior-preserving: identical CLI surface, run artifacts (`runs/<id>/…`), config.
- Stay behind the seams (`StructuredInvoke`, `onProgress`). **ZERO change to `src/agent/graph.ts`. NO design-retry loop.**
- `designTestCases` keeps its signature (`(input, deps) => Promise<TestCase[]>`).
- **DRY:** ONE exported `caseSimilarity(a, b): "merge" | "flag" | "distinct"` in `src/design/dedup.ts`,
  shared by `dedupCases` AND the `case_redundancy` scorer. Do NOT restate the "near-duplicate" rule anywhere else.
- Conservative merge key: same `technique` AND `type` AND identical `elementRefs` set AND normalized-`steps`
  Jaccard ≥ 0.9. Representative by `priority` (critical>high>medium>low) > more `steps` > earliest.
- Per-task gate (before each commit): `npm run typecheck && npm run lint && npm test && npm run build`.
- Spec source of truth: `docs/superpowers/specs/2026-06-19-case-quality-design.md`.

**Plan refinements vs the spec (recon-driven):**
- `designTestCases` has NO `onProgress` hook (`DesignDeps = { invoke, prompts }`), and adding one /
  touching `graph.ts` is out of scope. So the dedup is surfaced via the **reduced case count** (the graph's
  existing "designTestCases — generated N cases" line now reflects the merged total) + the **`case_redundancy`
  score**. AC2 ("redundancy reported") is satisfied by the score; the separate dedup `onProgress` line is dropped.
- Tests are EXCLUDED from `npm run typecheck` (`tsconfig.json` excludes `tests/`), so test fixtures use a
  `tc()` helper and need only the fields the logic reads (`technique`, `type`, `elementRefs`, `steps`,
  `priority`, `title`, `id`).

---

### Task 1: `caseSimilarity` + `dedupCases` (the deterministic core)

**Files:**
- Create: `src/design/dedup.ts`
- Test: `tests/unit/dedup.test.ts`

**Interfaces:**
- Consumes: `TestCase` from `./schema.js` (`{ id, title, technique, type, kind, execution, preconditions, steps, expected, priority, elementRefs }`).
- Produces:
  - `caseSimilarity(a: TestCase, b: TestCase): "merge" | "flag" | "distinct"`
  - `dedupCases(cases: TestCase[]): { merged: TestCase[]; flagged: DuplicateGroup[] }`
  - `interface DuplicateGroup { representative: TestCase; duplicates: TestCase[]; reason: "merged" | "flagged" }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dedup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { caseSimilarity, dedupCases } from "../../src/design/dedup.js";
import type { TestCase } from "../../src/design/schema.js";

const tc = (over: Partial<TestCase>): TestCase => ({
  id: "x", title: "t", technique: "exploratory", type: "Positive", kind: "active",
  execution: "auto", preconditions: [], steps: ["a"], expected: "e", priority: "medium",
  elementRefs: [], ...over,
});

describe("caseSimilarity", () => {
  it("merge: same technique+type, identical refs, near-identical steps", () => {
    const a = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    const b = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    expect(caseSimilarity(a, b)).toBe("merge");
  });
  it("distinct: different technique on the same field (diversity protected)", () => {
    const a = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    const b = tc({ technique: "equivalence-partitioning", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    expect(caseSimilarity(a, b)).toBe("distinct");
  });
  it("distinct: Positive vs Negative never merge", () => {
    const a = tc({ technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["enter 0"] });
    const b = tc({ technique: "boundary-value", type: "Negative", elementRefs: ["e1"], steps: ["enter 0"] });
    expect(caseSimilarity(a, b)).toBe("distinct");
  });
  it("flag: same technique+type, overlapping but not identical refs, different steps", () => {
    const a = tc({ technique: "exploratory", type: "Positive", elementRefs: ["e1", "e2"], steps: ["click a"] });
    const b = tc({ technique: "exploratory", type: "Positive", elementRefs: ["e2", "e3"], steps: ["click b totally different"] });
    expect(caseSimilarity(a, b)).toBe("flag");
  });
});

describe("dedupCases", () => {
  it("merges high-confidence dups, keeping the higher-priority representative", () => {
    const a = tc({ id: "tc-1", priority: "low", technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["click x"] });
    const b = tc({ id: "tc-2", priority: "critical", technique: "boundary-value", type: "Positive", elementRefs: ["e1"], steps: ["click x"] });
    const { merged, flagged } = dedupCases([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("tc-2"); // critical beats low
    expect(flagged.some((g) => g.reason === "merged")).toBe(true);
  });
  it("keeps borderline pairs (flagged, not dropped)", () => {
    const a = tc({ id: "tc-1", technique: "exploratory", type: "Positive", elementRefs: ["e1", "e2"], steps: ["click a"] });
    const b = tc({ id: "tc-2", technique: "exploratory", type: "Positive", elementRefs: ["e2", "e3"], steps: ["click b totally different"] });
    const { merged, flagged } = dedupCases([a, b]);
    expect(merged).toHaveLength(2);
    expect(flagged.some((g) => g.reason === "flagged")).toBe(true);
  });
  it("leaves distinct cases untouched; 0/1 case is a no-op", () => {
    expect(dedupCases([]).merged).toHaveLength(0);
    const a = tc({ technique: "boundary-value", elementRefs: ["e1"] });
    expect(dedupCases([a]).merged).toHaveLength(1);
    const b = tc({ technique: "state-transition", elementRefs: ["e9"] });
    expect(dedupCases([a, b]).merged).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dedup.test.ts`
Expected: FAIL — `Cannot find module '../../src/design/dedup.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/design/dedup.ts`:

```ts
import type { TestCase } from "./schema.js";

export interface DuplicateGroup {
  representative: TestCase;
  duplicates: TestCase[];
  reason: "merged" | "flagged";
}

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ");
const stepSet = (steps: string[]): Set<string> => new Set(steps.map(norm));
const refsKey = (refs: string[]): string => [...refs].sort().join("|");

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Single source of truth for "near-duplicate". Shared by dedupCases and the case_redundancy scorer. */
export function caseSimilarity(a: TestCase, b: TestCase): "merge" | "flag" | "distinct" {
  if (a.technique !== b.technique || a.type !== b.type) return "distinct";
  const sameRefs = refsKey(a.elementRefs) === refsKey(b.elementRefs);
  if (sameRefs && jaccard(stepSet(a.steps), stepSet(b.steps)) >= 0.9) return "merge";
  const aSet = new Set(a.elementRefs);
  const overlap = b.elementRefs.some((r) => aSet.has(r));
  if ((overlap && !sameRefs) || (norm(a.title) === norm(b.title) && !sameRefs)) return "flag";
  return "distinct";
}

/** Better representative: higher priority, then more steps, then the earlier one (a). */
function better(a: TestCase, b: TestCase): TestCase {
  const pa = PRIORITY_RANK[a.priority] ?? 0;
  const pb = PRIORITY_RANK[b.priority] ?? 0;
  if (pa !== pb) return pa > pb ? a : b;
  if (a.steps.length !== b.steps.length) return a.steps.length > b.steps.length ? a : b;
  return a;
}

/** Tiered dedup: merge high-confidence dups (keep best rep), flag borderline (kept, counted). */
export function dedupCases(cases: TestCase[]): { merged: TestCase[]; flagged: DuplicateGroup[] } {
  const reps: TestCase[] = [];
  const flagged: DuplicateGroup[] = [];
  for (const c of cases) {
    let mergedIn = false;
    for (let k = 0; k < reps.length; k += 1) {
      if (caseSimilarity(reps[k]!, c) === "merge") {
        const winner = better(reps[k]!, c);
        const loser = winner === reps[k]! ? c : reps[k]!;
        flagged.push({ representative: winner, duplicates: [loser], reason: "merged" });
        reps[k] = winner;
        mergedIn = true;
        break;
      }
    }
    if (!mergedIn) {
      for (const r of reps) {
        if (caseSimilarity(r, c) === "flag") flagged.push({ representative: r, duplicates: [c], reason: "flagged" });
      }
      reps.push(c);
    }
  }
  return { merged: reps, flagged };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/dedup.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/design/dedup.ts tests/unit/dedup.test.ts
git commit -m "feat(design): deterministic tiered case dedup + caseSimilarity (#58)"
```

---

### Task 2: Apply dedup inside `designTestCases`

**Files:**
- Modify: `src/design/index.ts`
- Test: `tests/unit/design.test.ts` (extend)

**Interfaces:**
- Consumes: `dedupCases` (Task 1).
- Produces: `designTestCases` now returns the DEDUPED `TestCase[]` (signature unchanged).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/design.test.ts` (inside the existing `describe`):

```ts
  it("merges near-duplicate cases the LLM emits (#58)", async () => {
    const dup = {
      title: "Boundary 0", technique: "boundary-value", type: "Positive", kind: "active",
      execution: "auto", preconditions: [], steps: ["Enter 0 into Email", "Submit"],
      expected: "rejected", priority: "high", elementRefs: ["e3", "e6"],
    };
    const fakeInvoke: StructuredInvoke = async (schema) =>
      schema.parse({ testCases: [dup, { ...dup, title: "Boundary 0 again" }] });
    const cases = await designTestCases(
      { study, pageSemantics: "x" },
      { invoke: fakeInvoke, prompts: new PromptRegistry() },
    );
    expect(cases).toHaveLength(1); // two identical-modulo-title cases → merged
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/design.test.ts`
Expected: FAIL — `expected length 2 to be 1` (no dedup yet).

- [ ] **Step 3: Write minimal implementation**

In `src/design/index.ts`, add the import near the others:

```ts
import { dedupCases } from "./dedup.js";
```

Then change the final `return` of `designTestCases` from:

```ts
  const known = new Set(els.map((e) => e.ref));
  return result.testCases.map((c, i) => ({
    ...c,
    id: `tc-${i + 1}`,
    elementRefs: c.elementRefs.filter((r) => known.has(r)),
  }));
```

to:

```ts
  const known = new Set(els.map((e) => e.ref));
  const grounded = result.testCases.map((c, i) => ({
    ...c,
    id: `tc-${i + 1}`,
    elementRefs: c.elementRefs.filter((r) => known.has(r)),
  }));
  return dedupCases(grounded).merged; // #58: merge high-confidence near-duplicates (reduced count is the report)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/design.test.ts`
Expected: PASS (the 2 original tests + the new one; the originals are unaffected — 1 case stays 1, [] stays []).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/design/index.ts tests/unit/design.test.ts
git commit -m "feat(design): dedup near-duplicate cases in designTestCases (#58)"
```

---

### Task 3: `technique_coverage` + `case_redundancy` scorers

**Files:**
- Modify: `src/eval/scorers.ts`
- Test: `tests/unit/scorers.test.ts` (extend)

**Interfaces:**
- Consumes: `ScoreInput.testCases` (existing); `caseSimilarity` from `../design/dedup.js` (Task 1).
- Produces: two new `Score`s — `technique_coverage` (distinct techniques / 6) and `case_redundancy`
  (cases in ≥1 non-distinct pair / total).

- [ ] **Step 1: Write the failing test**

Append a new `it` to `tests/unit/scorers.test.ts` (inside the existing `describe`):

```ts
  it("technique_coverage and case_redundancy (#58)", () => {
    const mk = (over: Partial<(typeof testCases)[number]>) => ({
      id: "x", title: "t", technique: "boundary-value", type: "Positive",
      preconditions: [], steps: ["enter 0"], expected: "e", priority: "high", elementRefs: ["e1"],
      ...over,
    });
    const cases = [
      mk({ id: "1" }),
      mk({ id: "2" }), // near-dup of 1
      mk({ id: "3", technique: "equivalence-partitioning", elementRefs: ["e9"], steps: ["other"] }),
    ];
    const scores = deterministicScores({ study, verified, testCases: cases as never, suite: undefined, validation: undefined });
    expect(byName(scores, "technique_coverage")).toBeCloseTo(2 / 6, 5); // boundary-value + equivalence-partitioning
    expect(byName(scores, "case_redundancy")).toBeCloseTo(2 / 3, 5); // cases 1 & 2 near-dup → 2 of 3
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scorers.test.ts`
Expected: FAIL — both scores `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/eval/scorers.ts`, add the import near the top:

```ts
import { caseSimilarity } from "../design/dedup.js";
```

Then, inside `deterministicScores`, immediately before `return scores;`, add:

```ts
  // technique_coverage (#58): breadth across the 6 ISO/IEC/IEEE 29119-4 techniques.
  if (input.testCases.length > 0) {
    const techniques = new Set(input.testCases.map((c) => c.technique));
    scores.push({ name: "technique_coverage", value: techniques.size / 6 });
  }
  // case_redundancy (#58): share of cases in >=1 near-duplicate pair (shared caseSimilarity — DRY).
  if (input.testCases.length > 1) {
    const involved = new Set<number>();
    for (let i = 0; i < input.testCases.length; i += 1) {
      for (let j = i + 1; j < input.testCases.length; j += 1) {
        if (caseSimilarity(input.testCases[i]!, input.testCases[j]!) !== "distinct") {
          involved.add(i);
          involved.add(j);
        }
      }
    }
    scores.push({ name: "case_redundancy", value: involved.size / input.testCases.length });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scorers.test.ts`
Expected: PASS (existing scorer tests + the new one).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/eval/scorers.ts tests/unit/scorers.test.ts
git commit -m "feat(eval): technique_coverage + case_redundancy scores (#58)"
```

---

### Task 4: Prompt nudge — technique breadth

**Files:**
- Modify: `src/prompts/local/qa-testcase-from-ui.ts`
- Modify: `docs/prompts/qa-testcase-from-ui.md` (doc parity, if present; gitignored → local-only)
- Test: `tests/unit/case-quality-prompt.test.ts` (new)

**Interfaces:**
- Consumes: the exported `QA_TESTCASE_FROM_UI` string.
- Produces: the prompt now names the 29119-4 techniques and asks for breadth + non-redundancy.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/case-quality-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { QA_TESTCASE_FROM_UI } from "../../src/prompts/local/qa-testcase-from-ui.js";

describe("qa-testcase-from-ui prompt (case-quality #58)", () => {
  it("nudges technique breadth by naming specific 29119-4 techniques", () => {
    expect(QA_TESTCASE_FROM_UI).toMatch(/boundary-value/);
    expect(QA_TESTCASE_FROM_UI).toMatch(/equivalence-partitioning/);
    expect(QA_TESTCASE_FROM_UI).toMatch(/variety|breadth|diversif/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/case-quality-prompt.test.ts`
Expected: FAIL — the prompt doesn't name the techniques yet.

- [ ] **Step 3: Write minimal implementation**

In `src/prompts/local/qa-testcase-from-ui.ts`, change the line:

```ts
Cover happy path AND negative/edge scenarios. No duplicates or trivialities.
```

to:

```ts
Cover happy path AND negative/edge scenarios. No duplicates or trivialities (no two cases with the same technique + same elements + same steps).
TECHNIQUE BREADTH: apply a VARIETY of 29119-4 techniques where the page allows — equivalence-partitioning, boundary-value, decision-table, state-transition, error-guessing — not just exploratory.
```

Then add the same two lines to `docs/prompts/qa-testcase-from-ui.md` if it exists (it is gitignored, so this edit is local-only — the `.ts` is the committed source of truth).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/case-quality-prompt.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/prompts/local/qa-testcase-from-ui.ts tests/unit/case-quality-prompt.test.ts
git commit -m "feat(prompts): nudge 29119-4 technique breadth in case design (#58)"
```

---

## Final verification (after all tasks)

- [ ] Full gate: `npm run typecheck && npm run lint && npm test && npm run build`
- [ ] Packaging smoke (if present): `npm run smoke:pack`
- [ ] Grep guard — confirm the invariants:
  - No `src/agent/graph.ts` change in `git diff main...feat/58-case-quality`.
  - `designTestCases` still returns `Promise<TestCase[]>` (signature unchanged).
  - "near-duplicate" is defined ONCE: `caseSimilarity` is the only place; `scorers.ts` imports it, does not restate it.

## Self-Review (run by the author)

**1. Spec coverage:**
- Component 1 `dedupCases`/`caseSimilarity` → Task 1. Component 2 (apply in designTestCases) → Task 2.
  Component 3 (technique_coverage + case_redundancy) → Task 3. Component 4 (prompt nudge) → Task 4. ✓
- AC1 (technique coverage) → Task 3. AC2 (redundancy reported) → Task 3 score (see refinement: via the
  score, not a new onProgress line). AC3 (high-conf merged) → Tasks 1+2. AC4 (borderline flagged not
  dropped) → Task 1 (dedupCases keeps reps, records flagged). AC5 (diversity protected) → Task 1 tests
  (different technique/type/refs → distinct). AC6 (no regression) → per-task gate + final grep guard. ✓

**2. Placeholder scan:** every code/test step has complete code + an exact command + expected output. No TBD/TODO. ✓

**3. Type consistency:** `caseSimilarity(a,b): "merge"|"flag"|"distinct"` and `dedupCases(): { merged, flagged }`
(Task 1) match their use in Task 2 (`dedupCases(grounded).merged`) and Task 3 (`caseSimilarity(...) !== "distinct"`).
`TestCase` fields used (`technique`, `type`, `elementRefs`, `steps`, `priority`, `title`, `id`) match
`src/design/schema.ts`. ✓
