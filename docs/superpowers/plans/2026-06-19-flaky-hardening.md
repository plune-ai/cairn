# Flaky-hardening (#57) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated `@playwright/test` specs less flaky — prefer robust locators, mandate proper
waits, and feed fragile-pattern findings into the existing repair loop.

**Architecture:** A deterministic linter (`lintSuite`) over generated code becomes a second repair-hint
source inside `runRepairLoop` (additive — absent ⇒ byte-identical to today). The `qa-playwright-ts-writer`
prompt gains an explicit waiting discipline (its only real gap; it already bans css/xpath/testid). A
tiered `locator_robustness` scorer + a deterministic fixture discriminator make the improvement
measurable in CI.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `@playwright/test`, zod.

## Global Constraints

- Behavior-preserving: identical CLI surface, run artifacts (`runs/<id>/…`), and config.
- Stay behind the seams (`BrowserGateway`, `StructuredInvoke`, `onProgress`). **ZERO change to `src/agent/graph.ts`.**
- Do NOT touch `failedTestsHint`, keep-best, or no-progress early-stop (the #40/#73 invariants).
  Protected by `tests/unit/repair-loop.test.ts`, `runner-output.test.ts`, `validate.test.ts`.
- `runRepairLoop` with no `lint` dep MUST behave byte-identically to today.
- Per-task gate (run before each commit): `npm run typecheck && npm run lint && npm test && npm run build`.
- Node 20+, `zod@^4.4.3`. Spec source of truth: `docs/superpowers/specs/2026-06-19-flaky-hardening-design.md`.

**Plan refinements vs the spec (recon-driven, documented for honesty):**
- The prompt is `src/prompts/local/qa-playwright-ts-writer.ts` (a TS constant), NOT a `.md`, and it
  ALREADY bans css/xpath/testid — so prompt-hardening is scoped to the missing **waiting** rules.
- AC3 is asserted via `greenRatio` (deterministic) instead of `flaky_ratio`: the fixture uses a FIXED
  mount delay so the fragile spec fails every run and the hardened spec passes every run — no randomness
  in a test (randomness would be self-defeating for a flakiness gate).

---

### Task 1: `lintSuite` + `lintHint` (deterministic anti-pattern detector)

**Files:**
- Create: `src/codegen/lint.ts`
- Test: `tests/unit/codegen-lint.test.ts`

**Interfaces:**
- Consumes: `GeneratedSuite` from `../codegen/schema.js` (`{ files: { path: string; content: string }[] }`).
- Produces:
  - `type LintFinding = { file: string; kind: "fragile-locator" | "prefer-role" | "bad-wait"; detail: string }`
  - `lintSuite(suite: GeneratedSuite): LintFinding[]`
  - `lintHint(findings: LintFinding[]): string` (empty string when no findings)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/codegen-lint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lintSuite, lintHint } from "../../src/codegen/lint.js";
import type { GeneratedSuite } from "../../src/codegen/index.js";

const suite = (content: string): GeneratedSuite => ({ files: [{ path: "a.spec.ts", content }] });

describe("lintSuite", () => {
  it("flags a CSS/locator() selector as fragile-locator", () => {
    const f = lintSuite(suite("await page.locator('#submit').click();"));
    expect(f.map((x) => x.kind)).toContain("fragile-locator");
  });

  it("flags getByTestId as prefer-role (mid, not fragile)", () => {
    const f = lintSuite(suite("await page.getByTestId('submit').click();"));
    expect(f).toHaveLength(1);
    expect(f[0]?.kind).toBe("prefer-role");
  });

  it("flags waitForTimeout and networkidle as bad-wait", () => {
    const f = lintSuite(suite("await page.waitForTimeout(500);\nawait page.waitForLoadState('networkidle');"));
    expect(f.filter((x) => x.kind === "bad-wait")).toHaveLength(2);
  });

  it("clean web-first code yields zero findings", () => {
    const f = lintSuite(suite("await expect(page.getByRole('button', { name: 'Go' })).toBeVisible();"));
    expect(f).toHaveLength(0);
  });

  it("carries the file path on each finding", () => {
    const f = lintSuite({ files: [{ path: "x/login.spec.ts", content: "page.locator('.x')" }] });
    expect(f[0]?.file).toBe("x/login.spec.ts");
  });

  it("lintHint is empty for no findings and a bulleted block otherwise", () => {
    expect(lintHint([])).toBe("");
    const hint = lintHint([{ file: "a.spec.ts", kind: "bad-wait", detail: "waitForTimeout" }]);
    expect(hint).toContain("Flaky-hardening");
    expect(hint).toContain("[bad-wait]");
    expect(hint).toContain("a.spec.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/codegen-lint.test.ts`
Expected: FAIL — `Cannot find module '../../src/codegen/lint.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/codegen/lint.ts`:

```ts
import type { GeneratedSuite } from "./schema.js";

export interface LintFinding {
  file: string;
  kind: "fragile-locator" | "prefer-role" | "bad-wait";
  detail: string;
}

// CSS/XPath/positional locators — fragile vs role+name (high severity).
const CSS_OR_XPATH = /\.locator\(|page\.\$\(|xpath=|>>|:nth-/;
// test-id — acceptable fallback but role+name is preferred (mid severity).
const TEST_ID = /getByTestId\(/;
// fixed sleeps + networkidle — flaky vs web-first auto-retrying assertions (high severity).
const BAD_WAIT = /waitForTimeout\(|networkidle/;

const snippet = (line: string): string => line.trim().slice(0, 120);

function scanLine(file: string, line: string): LintFinding[] {
  const out: LintFinding[] = [];
  if (TEST_ID.test(line)) {
    out.push({ file, kind: "prefer-role", detail: `getByTestId — prefer getByRole({ name }); test-id only without an accessible name: ${snippet(line)}` });
  }
  if (CSS_OR_XPATH.test(line)) {
    out.push({ file, kind: "fragile-locator", detail: `CSS/XPath locator — replace with getByRole/getByLabel/getByText: ${snippet(line)}` });
  }
  if (BAD_WAIT.test(line)) {
    out.push({ file, kind: "bad-wait", detail: `waitForTimeout/networkidle — use web-first await expect(locator).toBeVisible(): ${snippet(line)}` });
  }
  return out;
}

/** Deterministic anti-pattern scan of generated specs (no I/O, never throws). Source of truth for "fragile". */
export function lintSuite(suite: GeneratedSuite): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const f of suite.files) {
    for (const line of f.content.split("\n")) findings.push(...scanLine(f.path, line));
  }
  return findings;
}

/** Format findings as a repair-hint block. Empty string when clean → a no-op when appended to a hint. */
export function lintHint(findings: LintFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((x) => `- [${x.kind}] ${x.file}: ${x.detail}`);
  return `Flaky-hardening — fix these fragile patterns:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/codegen-lint.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green.

```bash
git add src/codegen/lint.ts tests/unit/codegen-lint.test.ts
git commit -m "feat(codegen): deterministic flaky-locator/bad-wait lint (#57)"
```

---

### Task 2: `runRepairLoop` accepts an optional `lint` dep (additive hint)

**Files:**
- Modify: `src/agent/repair-loop.ts`
- Test: `tests/unit/repair-loop.test.ts` (extend)

**Interfaces:**
- Consumes: `GeneratedSuite`, `RepairLoopDeps` (existing).
- Produces: `RepairLoopDeps.lint?: (suite: GeneratedSuite) => string` — when present, its output is appended
  to the repair hint AFTER `failedTestsHint(...)`; when absent, the hint is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/repair-loop.test.ts` (inside the existing `describe`):

```ts
  it("with a lint dep, appends lint findings to the repair hint, keeping the failure cause (#57)", async () => {
    const h = harness([
      report([{ test: "t", status: "failed", error: "boom" }], 0),
      report([{ test: "t", status: "passed" }], 1),
    ]);
    const lint = (): string => "Flaky-hardening — fix these fragile patterns:\n- [bad-wait] s0.spec.ts: waitForTimeout";
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3, lint });
    expect(r.bestValidation.greenRatio).toBe(1);
    expect(h.hints[1]).toContain("t: boom");        // #73 failure cause preserved
    expect(h.hints[1]).toContain("Flaky-hardening"); // #57 lint findings appended
  });

  it("without a lint dep, the repair hint is byte-identical to failedTestsHint (#73 guard)", async () => {
    const h = harness([
      report([{ test: "t", status: "failed", error: "boom" }], 0),
      report([{ test: "t", status: "passed" }], 1),
    ]);
    await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3 });
    expect(h.hints[1]).toBe("- t: boom"); // nothing appended
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/repair-loop.test.ts`
Expected: the first new test FAILS (`lint` not in deps type / not applied); the guard test passes.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/repair-loop.ts`, add to the `RepairLoopDeps` interface (after `onProgress?`):

```ts
  /** Optional: extra repair guidance from linting the FAILED suite (flaky-hardening, #57). Absent → no-op. */
  lint?: (suite: GeneratedSuite) => string;
```

Then in `runRepairLoop`, replace the hint-building lines inside the loop:

```ts
    attempts += 1;
    const failed = failedTestsHint(validation.results);
    suite = await deps.generate(failed);
```

with:

```ts
    attempts += 1;
    const failed = failedTestsHint(validation.results);
    const lintFindings = deps.lint?.(suite) ?? ""; // lint the suite that produced this failing validation
    const hint = [failed, lintFindings].filter(Boolean).join("\n");
    deps.onProgress?.(`repair — attempt ${attempts}`);
    suite = await deps.generate(hint);
```

Note: the original `deps.onProgress?.(\`repair — attempt ${attempts}\`)` line moves up as shown; do not
duplicate it. `suite` at this point is the suite that `validation` was computed from (the failed one).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/repair-loop.test.ts`
Expected: PASS (all, including the 6 original #40/#73 tests untouched).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/agent/repair-loop.ts tests/unit/repair-loop.test.ts
git commit -m "feat(repair): optional lint dep appends flaky-hardening hints (#57)"
```

---

### Task 3: Wire the automate flow to inject the lint

**Files:**
- Modify: `src/agent/index.ts` (the automate `runRepairLoop` call ~line 707)

**Interfaces:**
- Consumes: `lintSuite`, `lintHint` (Task 1); `RepairLoopDeps.lint` (Task 2).
- Produces: nothing new — wires existing pieces so `automate --validate` repairs with lint hints.

- [ ] **Step 1: Add the import**

In `src/agent/index.ts`, near the other agent imports (by `import { runRepairLoop } from "./repair-loop.js";`):

```ts
import { lintSuite, lintHint } from "../codegen/lint.js";
```

- [ ] **Step 2: Inject the lint into the runRepairLoop call**

In the automate block, change the `runRepairLoop({ ... })` call to add the `lint` field:

```ts
    const result = await runRepairLoop({
      generate: async (hint) => {
        const s = await buildSuite(hint);
        await runWriter.writeSuite(s);
        return s;
      },
      validate: () => validateSuite(runWriter.dir, { storageStatePath: sessionPath, channel: cfg.browser.channel, workers: cfg.playwrightWorkers }),
      maxRepair: cfg.maxRepair,
      onProgress,
      lint: (s) => lintHint(lintSuite(s)), // #57: feed fragile-pattern findings into repair
    });
```

- [ ] **Step 3: Verify the wiring type-checks and nothing regressed**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green. (The mechanism is unit-tested in Task 2; this step proves the type-safe injection
and that existing automate tests still pass.)

- [ ] **Step 4: Commit**

```bash
git add src/agent/index.ts
git commit -m "feat(automate): repair with flaky-hardening lint hints (#57)"
```

---

### Task 4: `locator_robustness` tiered scorer

**Files:**
- Modify: `src/eval/scorers.ts`
- Test: `tests/unit/scorers.test.ts` (extend)

**Interfaces:**
- Consumes: `ScoreInput.suite` (existing).
- Produces: a new `Score` named `locator_robustness` in `deterministicScores(...)` output
  (role+name=1 · label/text/placeholder/alt/title=0.8 · testid=0.5 · css/locator=0). `locator_quality`
  is left untouched.

- [ ] **Step 1: Write the failing test**

Append to the first `it(...)` in `tests/unit/scorers.test.ts` (the suite is
`"page.getByRole('button'); page.getByLabel('x'); page.locator('#css');"`):

```ts
    expect(byName(scores, "locator_robustness")).toBeCloseTo(1.8 / 3, 5); // role 1 + label .8 + css 0 over 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scorers.test.ts`
Expected: FAIL — `locator_robustness` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/eval/scorers.ts`, after the existing `locator_quality` block (before `return scores;`):

```ts
  // locator_robustness (#57): tiered selector strength, reconciling the DoD ranking
  // role+name > test-id > css > text. Complements the binary locator_quality (kept as-is).
  if (input.suite) {
    const code = input.suite.files.map((f) => f.content).join("\n");
    const roleName = (code.match(/getByRole\(/g) ?? []).length;
    const labelText = (code.match(/getBy(Label|Text|Placeholder|AltText|Title)\(/g) ?? []).length;
    const testid = (code.match(/getByTestId\(/g) ?? []).length;
    const css = (code.match(/\.locator\(|page\.\$\(/g) ?? []).length;
    const total = roleName + labelText + testid + css;
    if (total > 0) {
      const weighted = roleName * 1 + labelText * 0.8 + testid * 0.5 + css * 0;
      scores.push({ name: "locator_robustness", value: weighted / total });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scorers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/eval/scorers.ts tests/unit/scorers.test.ts
git commit -m "feat(eval): tiered locator_robustness score (#57)"
```

---

### Task 5: Prompt-hardening — mandate proper waits

**Files:**
- Modify: `src/prompts/local/qa-playwright-ts-writer.ts`
- Modify: `docs/prompts/qa-playwright-ts-writer.md` (doc parity)
- Test: `tests/unit/prompt-hardening.test.ts` (new)

**Interfaces:**
- Consumes: exported `QA_PLAYWRIGHT_TS_WRITER` string constant.
- Produces: the prompt now forbids `waitForTimeout`/`networkidle` and mandates web-first assertions.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prompt-hardening.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { QA_PLAYWRIGHT_TS_WRITER } from "../../src/prompts/local/qa-playwright-ts-writer.js";

describe("qa-playwright-ts-writer prompt (flaky-hardening #57)", () => {
  it("forbids flaky waits and mandates web-first assertions", () => {
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/waitForTimeout/);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/networkidle/);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/web-first|auto-?retr|auto-?wait/i);
  });

  it("still bans css/xpath/testid (unchanged locator discipline)", () => {
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/NO CSS\/XPath\/testid/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/prompt-hardening.test.ts`
Expected: FAIL — the first test fails (no `waitForTimeout`/`networkidle` mention yet).

- [ ] **Step 3: Write minimal implementation**

In `src/prompts/local/qa-playwright-ts-writer.ts`, insert a waiting rule. Change:

```ts
- One test case → one test('<name>', async ({ page }) => { ... }) with verifiable await expect(...).
```

to:

```ts
- Waiting (STRICT): rely on web-first auto-retrying assertions (await expect(locator).toBeVisible()/toBeEnabled()). NEVER page.waitForTimeout(...) or waitForLoadState('networkidle') — both are flaky. Playwright auto-waits for actionability; do NOT add manual sleeps.
- One test case → one test('<name>', async ({ page }) => { ... }) with verifiable await expect(...).
```

Then add the same rule to `docs/prompts/qa-playwright-ts-writer.md` under its rules list (keep doc/code parity).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/prompt-hardening.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add src/prompts/local/qa-playwright-ts-writer.ts docs/prompts/qa-playwright-ts-writer.md tests/unit/prompt-hardening.test.ts
git commit -m "feat(prompts): mandate web-first waits in codegen (#57)"
```

---

### Task 6: Flaky fixture + deterministic discriminator (the measurement proof)

**Files:**
- Create: `tests/fixtures/site/flaky.html`
- Create: `tests/integration/flaky-fixture.test.ts`

**Interfaces:**
- Consumes: `startFixtureServer` (`tests/fixtures/server.ts`), `ArtifactStore`, `validateSuite`,
  `isMissingBrowserError`.
- Produces: a CI-skippable integration test proving hardened (web-first) specs are green and fragile
  (fixed-sleep) specs are not, against a fixed-delay fixture.

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/site/flaky.html`:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>flaky</title></head>
  <body>
    <button id="trigger">Load</button>
    <div id="slot"></div>
    <script>
      document.getElementById("trigger").addEventListener("click", function () {
        // Element mounts after a FIXED 400ms delay: a fixed short sleep misses it (deterministic
        // failure), while a web-first assertion auto-waits and always finds it (deterministic pass).
        setTimeout(function () {
          var b = document.createElement("button");
          b.textContent = "Confirm";
          document.getElementById("slot").appendChild(b);
        }, 400);
      });
    </script>
  </body>
</html>
```

- [ ] **Step 2: Write the integration test (it is the failing test until the fixture is served)**

Create `tests/integration/flaky-fixture.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { validateSuite } from "../../src/validate/index.js";
import { isMissingBrowserError } from "../../src/browser/preflight.js";

const ITEST_BASE = join(process.cwd(), "runs", ".itest-flaky");

const spec = (name: string, body: string): string =>
  `import { test, expect } from '@playwright/test';\ntest('${name}', async ({ page }) => {\n${body}\n});`;

describe("flaky-hardening discriminator (integration, real playwright)", () => {
  let server: FixtureServer;
  beforeAll(async () => { server = await startFixtureServer(); });
  afterAll(async () => { await server.close(); });

  it("hardened spec stays green; fragile spec does not (#57)", { timeout: 180000 }, async (ctx) => {
    await rm(ITEST_BASE, { recursive: true, force: true });
    try {
      const hardened = await new ArtifactStore(join(ITEST_BASE, "hardened")).openRun("h");
      await hardened.writeSuite({ files: [{ path: "h.spec.ts", content: spec("hardened", `
  await page.goto('${server.url}/flaky.html');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();`) }] });

      const fragile = await new ArtifactStore(join(ITEST_BASE, "fragile")).openRun("f");
      await fragile.writeSuite({ files: [{ path: "f.spec.ts", content: spec("fragile", `
  await page.goto('${server.url}/flaky.html');
  await page.getByRole('button', { name: 'Load' }).click();
  await page.waitForTimeout(50);
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 50 });`) }] });

      let hardenedReport: Awaited<ReturnType<typeof validateSuite>>;
      let fragileReport: Awaited<ReturnType<typeof validateSuite>>;
      try {
        hardenedReport = await validateSuite(hardened.dir, { reruns: 5 });
        fragileReport = await validateSuite(fragile.dir, { reruns: 5 });
      } catch (e) {
        if (isMissingBrowserError(e)) { ctx.skip(); return; }
        throw e;
      }
      expect(hardenedReport.greenRatio).toBe(1);        // web-first waiting → rock-solid
      expect(fragileReport.greenRatio).toBeLessThan(1); // 100ms sleep vs 400ms mount → never green
    } finally {
      await rm(ITEST_BASE, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/integration/flaky-fixture.test.ts`
Expected: PASS (or SKIP if the playwright browser isn't installed — `npx playwright install chromium`).

- [ ] **Step 4: Run the gate and commit**

Run: `npm run typecheck && npm run lint && npm test && npm run build`

```bash
git add tests/fixtures/site/flaky.html tests/integration/flaky-fixture.test.ts
git commit -m "test(57): deterministic flaky-hardening fixture discriminator"
```

---

## Final verification (after all tasks)

- [ ] Full gate: `npm run typecheck && npm run lint && npm test && npm run build`
- [ ] Packaging smoke (if present): `npm run smoke:pack`
- [ ] Grep guard — confirm the invariants are intact:
  - `failedTestsHint` body unchanged (only the call-site composes it with the lint hint).
  - No `src/agent/graph.ts` change in `git diff main...feat/57-flaky-hardening`.

## Self-Review (run by the author)

**1. Spec coverage:**
- Component 1 `lintSuite` → Task 1. Component 2 prompt-hardening → Task 5. Component 3 reactive lint-hint
  → Tasks 2+3. Component 4 `locator_robustness` → Task 4. Component 5 fixture/harness → Task 6. ✓
- AC1 (robust locators / `locator_robustness ≥ 0.8`) → Task 4 score + Task 5 prompt; verifiable on a
  recorded generation. AC2 (no `waitForTimeout`/`networkidle`) → Tasks 1+5. AC3 (flaky-rate drop) → Task 6
  (greenRatio form, see refinement note). AC4 (reward feeds repair) → Tasks 2+3. AC5 (no regression) →
  per-task gate + the final grep guard. ✓
- Out-of-scope items (per-locator attribution, cross-run memory, explore repair node, deprecating
  locator_quality) are NOT scheduled — correct. ✓

**2. Placeholder scan:** every code/test step contains complete code and an exact command + expected
output. No TBD/TODO. ✓

**3. Type consistency:** `LintFinding`/`lintSuite`/`lintHint` (Task 1) match their use in Task 2's test
and Task 3's wiring. `RepairLoopDeps.lint?: (suite: GeneratedSuite) => string` (Task 2) matches the
injected `(s) => lintHint(lintSuite(s))` (Task 3). `GeneratedSuite` shape is `{ files: { path; content }[] }`
throughout. ✓
