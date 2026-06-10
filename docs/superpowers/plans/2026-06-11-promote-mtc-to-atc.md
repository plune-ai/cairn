# Promote MTC → ATC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user promote a reviewed manual (MTC) test case into an automatable (ATC) one — renaming in place with correct numbering and re-collected selectors — exposed via a CLI command and a TUI action.

**Architecture:** New isolated `src/promote/` module with a browser-free `promoteCase()` (convert-only, in-place) and a `collectSelectors()` (offline `study.json` first, injected live fallback). The CLI command wires the live fallback from `BrowserGateway`; the TUI action calls it offline. Code generation stays in `automate` (decoupled).

**Tech Stack:** Node 20 ESM, TypeScript strict, vitest, commander, Ink. Reuses `locatorFor` (`src/artifacts/report.ts`) and `parseTestCaseMd` (`src/artifacts/testcase-md.ts`).

---

## File Structure

- **Create** `src/promote/selectors.ts` — `collectSelectors(runDir, refs, deps)` + `PromoteDeps` type.
- **Create** `src/promote/promote-case.ts` — `promoteCase(runDir, caseId, deps)` + markdown helpers + `PromoteResult`.
- **Create** `src/promote/index.ts` — barrel re-export of both (internal; NOT added to `src/index.ts`).
- **Modify** `src/cli/index.ts` — add the `promote` command (builds the live fallback from a session).
- **Modify** `src/tui/screens/run-detail-screen.tsx` — `a` key promotes an MTC case (offline), then reloads.
- **Test** `tests/unit/promote/selectors.test.ts`, `tests/unit/promote/promote-case.test.ts`, `tests/unit/tui/run-detail-promote.test.tsx`.

Note: `.md` does not store `elementRefs` and its `id` (`MTC-SUITE-001`) differs from `report.json`'s (`tc-1`). When selectors must be refilled, we match the case to `report.json` **by title** to recover its `elementRefs`.

---

### Task 1: `collectSelectors` (offline study.json + injectable live fallback)

**Files:**
- Create: `src/promote/selectors.ts`
- Test: `tests/unit/promote/selectors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/promote/selectors.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSelectors } from "../../../src/promote/selectors.js";

describe("collectSelectors", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promote-sel-"));
    await writeFile(
      join(dir, "study.json"),
      JSON.stringify({
        url: "https://x",
        elements: [
          { ref: "e45", role: "textbox", name: "Full Name", interactive: true, rank: 5 },
          { ref: "e49", role: "button", name: "Submit", interactive: true, rank: 9 },
        ],
      }),
    );
    await writeFile(join(dir, "report.json"), JSON.stringify({ url: "https://x" }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fills selectors from study elements (offline)", async () => {
    const { selectors, missing } = await collectSelectors(dir, ["e45", "e49"]);
    expect(missing).toEqual([]);
    expect(selectors).toContainEqual({
      label: "Full Name",
      locator: "page.getByRole('textbox', { name: 'Full Name' })",
    });
    expect(selectors).toContainEqual({
      label: "Submit",
      locator: "page.getByRole('button', { name: 'Submit' })",
    });
  });

  it("reports refs missing from study when no live fallback", async () => {
    const { selectors, missing } = await collectSelectors(dir, ["e45", "e99"]);
    expect(selectors).toHaveLength(1);
    expect(missing).toEqual(["e99"]);
  });

  it("uses the live fallback (with report.json url) for missing refs", async () => {
    const collectLive = async (url: string, refs: string[]): Promise<Map<string, string>> => {
      expect(url).toBe("https://x");
      return new Map(refs.map((r) => [r, `page.getByRole('link') /* ${r} */`]));
    };
    const { selectors, missing } = await collectSelectors(dir, ["e99"], { collectLive });
    expect(missing).toEqual([]);
    expect(selectors[0]?.locator).toContain("getByRole('link')");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/promote/selectors.test.ts`
Expected: FAIL — cannot find module `src/promote/selectors.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/promote/selectors.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { locatorFor } from "../artifacts/report.js";
import type { ElementRef } from "../browser/index.js";

export interface PromoteDeps {
  /** Live browser fallback for refs missing from study.json. Omit → offline-only. */
  collectLive?: (url: string, refs: string[]) => Promise<Map<string, string>>;
}

export interface CollectedSelectors {
  selectors: { label: string; locator: string }[];
  missing: string[];
}

/** Build selectors for elementRefs: study.json (offline) first, then an optional live fallback. */
export async function collectSelectors(
  runDir: string,
  elementRefs: string[],
  deps: PromoteDeps = {},
): Promise<CollectedSelectors> {
  let elements: ElementRef[] = [];
  try {
    const study = JSON.parse(await readFile(join(runDir, "study.json"), "utf8")) as {
      elements?: ElementRef[];
    };
    elements = study.elements ?? [];
  } catch {
    // no study.json — every ref is missing (live fallback may still fill them)
  }
  const byRef = new Map(elements.map((e) => [e.ref, e]));

  const selectors: { label: string; locator: string }[] = [];
  const missing: string[] = [];
  for (const ref of elementRefs) {
    const el = byRef.get(ref);
    if (el) selectors.push({ label: el.name ?? el.role, locator: locatorFor(el) });
    else missing.push(ref);
  }

  if (missing.length === 0 || !deps.collectLive) return { selectors, missing };

  let url = "";
  try {
    const rep = JSON.parse(await readFile(join(runDir, "report.json"), "utf8")) as { url?: string };
    url = rep.url ?? "";
  } catch {
    // no report.json → cannot navigate
  }
  if (!url) return { selectors, missing };

  const live = await deps.collectLive(url, missing);
  const stillMissing: string[] = [];
  for (const ref of missing) {
    const loc = live.get(ref);
    if (loc) selectors.push({ label: ref, locator: loc });
    else stillMissing.push(ref);
  }
  return { selectors, missing: stillMissing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/promote/selectors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/promote/selectors.ts tests/unit/promote/selectors.test.ts
git commit -m "feat(promote): collectSelectors (study.json offline + live fallback)"
```

---

### Task 2: `promoteCase` (numbering, frontmatter, selectors, traceability, in-place rename)

**Files:**
- Create: `src/promote/promote-case.ts`
- Create: `src/promote/index.ts`
- Test: `tests/unit/promote/promote-case.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/promote/promote-case.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteCase } from "../../../src/promote/promote-case.js";

const MTC = `---
id: MTC-DEMO-001
title: "Submit empty form shows errors"
suite: DEMO
priority: P1
type: Negative
execution: manual
status: 📋 Manual
automation: — (manual, not automated)
---

# MTC-DEMO-001: Submit empty form shows errors

## Preconditions

- The form is open

## Steps

1. Click Submit without filling fields

## Expected Result

- Validation errors are shown
`;

describe("promoteCase", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promote-case-"));
    const tc = join(dir, "testcases");
    await mkdir(tc, { recursive: true });
    await writeFile(join(tc, "ATC-DEMO-001.md"), "---\nid: ATC-DEMO-001\n---\n# x\n");
    await writeFile(join(tc, "ATC-DEMO-002.md"), "---\nid: ATC-DEMO-002\n---\n# x\n");
    await writeFile(join(tc, "MTC-DEMO-001.md"), MTC);
    await writeFile(
      join(dir, "report.json"),
      JSON.stringify({
        url: "https://x",
        testCases: [
          { id: "tc-9", title: "Submit empty form shows errors", elementRefs: ["e49"] },
        ],
      }),
    );
    await writeFile(
      join(dir, "study.json"),
      JSON.stringify({
        url: "https://x",
        elements: [{ ref: "e49", role: "button", name: "Submit", interactive: true, rank: 9 }],
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renames MTC→next free ATC number and rewrites frontmatter", async () => {
    const res = await promoteCase(dir, "MTC-DEMO-001");
    expect(res.oldId).toBe("MTC-DEMO-001");
    expect(res.newId).toBe("ATC-DEMO-003"); // 001/002 exist → 003

    const files = await readdir(join(dir, "testcases"));
    expect(files).toContain("ATC-DEMO-003.md");
    expect(files).not.toContain("MTC-DEMO-001.md"); // in-place: original gone

    const md = await readFile(join(dir, "testcases", "ATC-DEMO-003.md"), "utf8");
    expect(md).toMatch(/^id:\s*ATC-DEMO-003$/m);
    expect(md).toMatch(/^execution:\s*auto$/m);
    expect(md).toMatch(/^automation:\s*tests\/ui\/demo\/atc-demo-003\.spec\.ts$/m);
    expect(md).toContain("Promoted from"); // traceability trail
    expect(md).toContain("MTC-DEMO-001");
  });

  it("refills selectors from study (matched by title) when the .md had none", async () => {
    const res = await promoteCase(dir, "MTC-DEMO-001");
    expect(res.selectorsFilled).toBe(1);
    const md = await readFile(join(dir, "testcases", res.newId + ".md"), "utf8");
    expect(md).toContain("## Selectors");
    expect(md).toContain("page.getByRole('button', { name: 'Submit' })");
  });

  it("rejects a non-MTC id", async () => {
    await expect(promoteCase(dir, "ATC-DEMO-001")).rejects.toThrow(/only MTC/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/promote/promote-case.test.ts`
Expected: FAIL — cannot find module `src/promote/promote-case.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/promote/promote-case.ts
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseTestCaseMd } from "../artifacts/testcase-md.js";
import { collectSelectors, type PromoteDeps } from "./selectors.js";

export interface PromoteResult {
  oldId: string;
  newId: string;
  oldFile: string;
  newFile: string;
  selectorsFilled: number;
  missingRefs: string[];
  warning?: string;
}

/** MTC-<SUITE>-NNN → <SUITE> (suite may contain dashes; strip leading kind + trailing number). */
function suiteOf(id: string): string {
  const m = id.match(/^(?:MTC|ATC)-(.+)-(\d+)$/);
  return m?.[1] ?? "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Next free ATC number for a suite, scanning testcases/ filenames. */
async function nextAtcNumber(tcDir: string, suite: string): Promise<number> {
  const files = await readdir(tcDir);
  const re = new RegExp(`^ATC-${escapeRe(suite)}-(\\d+)\\.md$`);
  let max = 0;
  for (const f of files) {
    const m = f.match(re);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Replace (or insert) a key in the leading `---` frontmatter block. */
function setFrontmatter(md: string, key: string, value: string): string {
  const re = new RegExp(`^(${escapeRe(key)}:).*$`, "m");
  if (re.test(md)) return md.replace(re, `$1 ${value}`);
  // insert before the closing --- (second occurrence)
  return md.replace(/\n---\n/, `\n${key}: ${value}\n---\n`);
}

/** Recover elementRefs by matching the case title against report.json. */
async function elementRefsForTitle(runDir: string, title: string): Promise<string[]> {
  try {
    const rep = JSON.parse(await readFile(join(runDir, "report.json"), "utf8")) as {
      testCases?: { title?: string; elementRefs?: string[] }[];
    };
    const hit = (rep.testCases ?? []).find((t) => t.title === title);
    return hit?.elementRefs ?? [];
  } catch {
    return [];
  }
}

/** Insert a `## Selectors` table after `## Expected Result` (or append at end). */
function injectSelectors(md: string, selectors: { label: string; locator: string }[]): string {
  if (selectors.length === 0 || md.includes("## Selectors")) return md;
  const rows = selectors.map((s) => `| ${s.label} | \`${s.locator}\` |`).join("\n");
  const block = `\n## Selectors (recorded during promote)\n\n| Element | Locator |\n| --- | --- |\n${rows}\n`;
  return md.trimEnd() + "\n" + block;
}

/** Append a "Promoted from" row to a `## Traceability` table (create the section if absent). */
function appendTraceability(md: string, oldId: string): string {
  const row = `| Promoted from | ${oldId} |`;
  if (md.includes("## Traceability")) {
    return md.replace(/(## Traceability[\s\S]*?\n)(\n|$)/, (m) => `${m.trimEnd()}\n${row}\n`);
  }
  return `${md.trimEnd()}\n\n## Traceability\n\n| Source | Reference |\n| --- | --- |\n${row}\n`;
}

export async function promoteCase(
  runDir: string,
  caseId: string,
  deps: PromoteDeps = {},
): Promise<PromoteResult> {
  if (!caseId.startsWith("MTC")) {
    throw new Error(`Cannot promote ${caseId}: only MTC-* (manual) cases can be promoted.`);
  }
  const tcDir = join(runDir, "testcases");
  const oldFile = join(tcDir, `${caseId}.md`);
  const md = await readFile(oldFile, "utf8");
  const parsed = parseTestCaseMd(md);

  const suite = suiteOf(caseId);
  const num = await nextAtcNumber(tcDir, suite);
  const newId = `ATC-${suite}-${String(num).padStart(3, "0")}`;
  const newFile = join(tcDir, `${newId}.md`);

  let selectorsFilled = 0;
  let missingRefs: string[] = [];
  let updated = md;
  if (parsed.selectors.length === 0) {
    const refs = await elementRefsForTitle(runDir, parsed.title);
    const { selectors, missing } = await collectSelectors(runDir, refs, deps);
    selectorsFilled = selectors.length;
    missingRefs = missing;
    updated = injectSelectors(updated, selectors);
  }

  const automation = `tests/ui/${suite.toLowerCase()}/${newId.toLowerCase()}.spec.ts`;
  updated = setFrontmatter(updated, "id", newId);
  updated = setFrontmatter(updated, "execution", "auto");
  updated = setFrontmatter(updated, "status", "❌ Not implemented");
  updated = setFrontmatter(updated, "automation", automation);
  updated = appendTraceability(updated, caseId);

  await writeFile(newFile, updated, "utf8");
  if (newFile !== oldFile) await unlink(oldFile); // in-place rename

  const warning =
    missingRefs.length > 0
      ? `${String(missingRefs.length)} ref(s) without a selector — generated code will be incomplete.`
      : undefined;
  return { oldId: caseId, newId, oldFile, newFile, selectorsFilled, missingRefs, warning };
}
```

```ts
// src/promote/index.ts
export { promoteCase } from "./promote-case.js";
export type { PromoteResult } from "./promote-case.js";
export { collectSelectors } from "./selectors.js";
export type { PromoteDeps, CollectedSelectors } from "./selectors.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/promote/promote-case.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/promote/ tests/unit/promote/promote-case.test.ts
git commit -m "feat(promote): promoteCase — in-place MTC->ATC with numbering + selectors"
```

---

### Task 3: CLI `promote` command (wires the live fallback from a session)

**Files:**
- Modify: `src/cli/index.ts` (add a command before the final dispatch block at line ~303)
- Test: covered by manual run + the unit tests above (CLI is thin glue; no new unit test).

- [ ] **Step 1: Add the command**

Add this `program.command("promote")` block alongside the other commands (e.g. after the `automate` block, before `const cliArgs = process.argv.slice(2);`):

```ts
program
  .command("promote")
  .description("Promote manual MTC case(s) to automatable ATC (.md only; run `automate` to generate code)")
  .requiredOption("--run <dir>", "run folder (runs/<id>)")
  .requiredOption("--cases <ids>", "comma-separated MTC ids, e.g. MTC-DEMO-001,MTC-DEMO-003")
  .option("--session <name>", "session for the live selector fallback")
  .option("--session-file <path>", "storageState path for the live selector fallback")
  .action(
    async (opts: { run: string; cases: string; session?: string; sessionFile?: string }) => {
      const config = loadConfig(process.env);
      const runDir = resolve(opts.run);
      const ids = opts.cases.split(",").map((s) => s.trim()).filter(Boolean);

      // Live fallback only when a session is provided.
      let collectLive: PromoteDeps["collectLive"];
      let storageState: StorageState | undefined;
      if (opts.sessionFile) storageState = await new SessionStore(resolve(".auth")).loadFile(resolve(opts.sessionFile));
      else if (opts.session) storageState = await new SessionStore(resolve(".auth")).load(opts.session);
      if (storageState) {
        collectLive = async (url: string, refs: string[]): Promise<Map<string, string>> => {
          const gateway = makeGateway({ backend: config.browser.backend, storageState, channel: config.browser.channel });
          try {
            await gateway.observe({ url });
            const verified = await gateway.verify(refs.map((ref) => ({ ref, role: "", interactive: true, rank: 0 })));
            const out = new Map<string, string>();
            for (const v of verified) if (v.verified) out.set(v.ref, locatorFor(v));
            return out;
          } finally {
            await gateway.close();
          }
        };
      }

      for (const id of ids) {
        const res = await promoteCase(runDir, id, { collectLive });
        process.stdout.write(`${res.oldId} → ${res.newId}${res.warning ? ` (⚠ ${res.warning})` : ""}\n`);
      }
      process.stdout.write(`\nDone. Run \`lex-bot automate --run ${opts.run}\` to generate code for the new ATC case(s).\n`);
    },
  );
```

- [ ] **Step 2: Add imports at the top of `src/cli/index.ts`**

```ts
import { promoteCase } from "../promote/index.js";
import type { PromoteDeps } from "../promote/index.js";
import { locatorFor } from "../artifacts/report.js";
```
(`makeGateway`, `SessionStore`, `loadConfig`, `StorageState`, `resolve` are already imported.)

> Note: the live fallback verifies by ref with empty role/name — it relies on the backend resolving the ref on the
> re-observed page. If a ref no longer resolves, it is reported as missing (warning), which is the intended behavior.

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean (exit 0).

- [ ] **Step 4: Manual smoke (offline path, no session)**

Run: `node dist/cli/index.js promote --run runs/<a-run-with-an-MTC> --cases MTC-<SUITE>-001`
Expected: prints `MTC-… → ATC-…`; the file is renamed in `testcases/`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(promote): lex-bot promote command (offline + session live fallback)"
```

---

### Task 4: TUI `a` action — promote an MTC case from the Cases tab (offline)

**Files:**
- Modify: `src/tui/screens/run-detail-screen.tsx`
- Test: `tests/unit/tui/run-detail-promote.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/tui/run-detail-promote.test.tsx
import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

const promoteCase = vi.fn(async () => ({
  oldId: "MTC-DEMO-001",
  newId: "ATC-DEMO-003",
  oldFile: "",
  newFile: "",
  selectorsFilled: 1,
  missingRefs: [],
}));
vi.mock("../../../src/promote/index.js", () => ({ promoteCase }));

vi.mock("../../../src/tui/hooks/use-run-artifacts.js", () => ({
  useRunArtifacts: () => ({
    cases: [{ name: "MTC-DEMO-001.md", text: "---\nid: MTC-DEMO-001\n---\n# x" }],
    report: "r",
    log: "l",
    loading: false,
  }),
}));

import { RunDetailScreen } from "../../../src/tui/screens/run-detail-screen.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RunDetailScreen promote", () => {
  it("pressing 'a' on an MTC case calls promoteCase", async () => {
    const { stdin, unmount } = render(<RunDetailScreen runDir="runs/x" />);
    await delay(20);
    stdin.write("a");
    await delay(40);
    expect(promoteCase).toHaveBeenCalledWith("runs/x", "MTC-DEMO-001", {});
    unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tui/run-detail-promote.test.tsx`
Expected: FAIL — `promoteCase` not called (no `a` handler yet).

- [ ] **Step 3: Implement the `a` handler**

In `src/tui/screens/run-detail-screen.tsx`, add imports:

```tsx
import { promoteCase } from "../../promote/index.js";
```

Add a state + reload signal near the other hooks:

```tsx
const [note, setNote] = useState<string>("");
```

Extend the `useInput` callback with an `a` branch (only for MTC cases on the Cases tab):

```tsx
    else if (tab === "cases" && input === "a" && current?.name.startsWith("MTC")) {
      const id = current.name.replace(/\.md$/, "");
      void promoteCase(runDir, id, {})
        .then((r) => setNote(`Promoted ${r.oldId} → ${r.newId}${r.warning ? ` (⚠ ${r.warning})` : ""}`))
        .catch((e: unknown) => setNote(`Promote failed: ${e instanceof Error ? e.message : String(e)}`));
    }
```

Show `note` under the panel (above the hint), and add `a promote` to the hint when the current case is MTC:

```tsx
      {note ? <Text color="green">{note}</Text> : null}
      <Text dimColor>{hint}</Text>
```

And compute the hint with the promote affordance:

```tsx
  const isMtc = tab === "cases" && current?.name.startsWith("MTC");
  const hint =
    tab === "cases"
      ? `↑↓ scroll · n/p case${isMtc ? " · a promote→ATC" : ""} · 1/2/3 or ←→ tab · esc back`
      : `↑↓ scroll · 1/2/3 or ←→ tab · esc back`;
```

> v1 TUI is offline-only (no `collectLive` passed). After a successful promote the user can re-open the run to see
> the new ATC id; a live reload of the artifact list is a follow-up nicety, not required here.

- [ ] **Step 4: Run test + build**

Run: `npx vitest run tests/unit/tui/run-detail-promote.test.tsx && npm run build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/run-detail-screen.tsx tests/unit/tui/run-detail-promote.test.tsx
git commit -m "feat(promote): TUI 'a' action promotes an MTC case to ATC (offline)"
```

---

### Task 5: Full gate + docs

- [ ] **Step 1: Full verification**

Run: `npm run build && npm run lint && npm run test:coverage`
Expected: clean build, clean lint, all tests pass, coverage gate unchanged (promote is integration-light glue; `promote/` is not in the coverage allowlist).

- [ ] **Step 2: Document the command**

In `README.md`, under `## Commands`, add a row:

```
| `lex-bot promote --run <dir> --cases <ids> [--session <s>]` | Promote manual MTC case(s) to ATC (.md only; then `automate`) |
```

And in the local `CLAUDE.md` Commands section, add one line mirroring it.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the promote command"
```

---

## Self-Review

- **Spec coverage:** in-place rename (Task 2 ✓), decoupled/convert-only (no codegen anywhere ✓), selectors hybrid (Task 1 offline + live; Task 3 wires live ✓), traceability (Task 2 `appendTraceability` ✓), CLI + TUI shared `promoteCase` (Tasks 3, 4 ✓), numbering max+1 (Task 2 `nextAtcNumber` ✓).
- **Spec correction:** elementRefs recovered **by title** from report.json (not by id) — noted in File Structure; update the spec's §promoteCase step 3 wording accordingly.
- **Placeholders:** none — every step has full code/commands.
- **Type consistency:** `PromoteDeps`/`collectLive` signature identical across selectors.ts, promote-case.ts, cli, tui; `PromoteResult` fields used consistently.
- **YAGNI:** no demote, no bulk-all, no codegen — matches spec out-of-scope.
