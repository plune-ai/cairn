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
    if (m?.[1] != null) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Replace (or insert) a key in the leading `---` frontmatter block. */
function setFrontmatter(md: string, key: string, value: string): string {
  const fmEnd = md.indexOf("\n---\n");
  if (fmEnd === -1) return md; // no frontmatter — bail
  const fm = md.slice(0, fmEnd);
  const rest = md.slice(fmEnd);
  const re = new RegExp(`^(${escapeRe(key)}:).*$`, "m");
  if (re.test(fm)) return fm.replace(re, `$1 ${value}`) + rest;
  return `${fm}\n${key}: ${value}${rest}`;
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

/** Insert a `## Selectors` table after the body (if absent). */
function injectSelectors(md: string, selectors: { label: string; locator: string }[]): string {
  if (selectors.length === 0 || md.includes("## Selectors")) return md;
  const rows = selectors.map((s) => `| ${s.label} | \`${s.locator}\` |`).join("\n");
  const block = `\n## Selectors (recorded during promote)\n\n| Element | Locator |\n| --- | --- |\n${rows}\n`;
  return md.trimEnd() + "\n" + block;
}

/** Append a "Promoted from" row to the ## Traceability section (create it if absent). */
function appendTraceability(md: string, oldId: string): string {
  const row = `| Promoted from | ${oldId} |`;
  const m = md.match(/## Traceability\b[\s\S]*?(?=\n## |\n*$)/);
  if (m) {
    const section = m[0].trimEnd();
    return md.replace(m[0], `${section}\n${row}`);
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
  updated = updated.replace(/^(#\s+)(?:MTC|ATC)-[A-Za-z0-9-]+-\d+(:)/m, `$1${newId}$2`);
  updated = appendTraceability(updated, caseId);

  await writeFile(newFile, updated, "utf8");
  if (newFile !== oldFile) await unlink(oldFile); // in-place rename

  const warning =
    missingRefs.length > 0
      ? `${missingRefs.length} ref(s) without a selector — generated code will be incomplete.`
      : undefined;
  return { oldId: caseId, newId, oldFile, newFile, selectorsFilled, missingRefs, warning };
}
