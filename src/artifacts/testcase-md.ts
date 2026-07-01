import type { TestCase } from "../design/index.js";
import type { ApiCase } from "../api/cases.js";

/** Context for rendering a single case into the user's ATC format. */
export interface TestCaseDoc {
  id: string;
  suite: string;
  status: string;
  automationPath: string;
  selectors: { label: string; locator: string }[];
  traceability: { source: string; reference: string }[];
}

/** Our priority → P1/P2/P3 (user's format). */
export function mapPriority(p: TestCase["priority"]): string {
  return p === "critical" || p === "high" ? "P1" : p === "medium" ? "P2" : "P3";
}

/** ASCII slug for file names / automation paths. */
export function slugify(s: string): string {
  const ascii = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length > 0 ? ascii.slice(0, 60) : "test";
}

/** Render a test case into ATC markdown (frontmatter + Preconditions/Steps/Expected/Selectors/Traceability). */
export function renderTestCaseMd(tc: TestCase, doc: TestCaseDoc): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${doc.id}`);
  lines.push(`title: "${tc.title.replace(/"/g, "'")}"`);
  lines.push(`suite: ${doc.suite}`);
  lines.push(`priority: ${mapPriority(tc.priority)}`);
  lines.push(`type: ${tc.type}`);
  lines.push(`execution: ${tc.execution}`);
  lines.push(`status: ${doc.status}`);
  lines.push(`automation: ${doc.automationPath}`);
  lines.push("---", "");
  lines.push(`# ${doc.id}: ${tc.title}`, "");

  lines.push("## Preconditions", "");
  if (tc.preconditions.length > 0) for (const p of tc.preconditions) lines.push(`- ${p}`);
  else lines.push("- (none)");
  lines.push("");

  lines.push("## Steps", "");
  const steps = tc.steps.length > 0 ? tc.steps : ["Open the page"];
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");

  lines.push("## Expected Result", "");
  lines.push(`- ${tc.expected}`);
  lines.push("");

  if (doc.selectors.length > 0) {
    lines.push("## Selectors (recorded during exploration)", "");
    lines.push("| Element | Locator |", "| --- | --- |");
    for (const s of doc.selectors) lines.push(`| ${s.label} | \`${s.locator}\` |`);
    lines.push("");
  }

  if (doc.traceability.length > 0) {
    lines.push("## Traceability", "");
    lines.push("| Source | Reference |", "| --- | --- |");
    for (const t of doc.traceability) lines.push(`| ${t.source} | ${t.reference} |`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Context for rendering one API case into ATC markdown (API-5, #135). */
export interface ApiTestCaseDoc {
  id: string;
  suite: string;
  /** Provenance-checked verdict (aligns with BORROW-04, #91) — only "Passed" backed by a real result. */
  status: string;
}

/**
 * Render an API case into the same ATC frontmatter contract as {@link renderTestCaseMd} (id/title/
 * suite/type/execution/status), with the operation's request/response contract and its methodology
 * tag (technique + coverage rationale) standing in for UI preconditions/steps/selectors.
 */
export function renderApiTestCaseMd(c: ApiCase, doc: ApiTestCaseDoc): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${doc.id}`);
  lines.push(`title: "${c.name.replace(/"/g, "'")}"`);
  lines.push(`suite: ${doc.suite}`);
  lines.push(`technique: ${c.technique}`);
  lines.push(`type: Positive`);
  lines.push(`execution: auto`);
  lines.push(`status: ${doc.status}`);
  lines.push("---", "");
  lines.push(`# ${doc.id}: ${c.name}`, "");

  lines.push("## Methodology", "");
  lines.push(`- Technique: ${c.technique}`);
  lines.push(`- Rationale: ${c.rationale}`);
  lines.push("");

  lines.push("## Request", "");
  lines.push(`- ${c.method} ${c.path}`);
  const sent: Record<string, unknown> = {};
  for (const [where, vals] of Object.entries(c.params)) {
    if (Object.keys(vals as object).length) sent[where] = vals;
  }
  if (c.body !== undefined) sent.body = c.body;
  if (Object.keys(sent).length) lines.push(`- Params/body: \`${JSON.stringify(sent)}\``);
  lines.push("");

  lines.push("## Expected Result", "");
  lines.push(`- HTTP ${c.expectedStatus}${c.expectedSchema !== undefined ? " conforming to the declared success schema" : ""}`);
  lines.push("");

  return lines.join("\n");
}

/** A parsed test case (for the automate command). */
export interface ParsedTestCase {
  id: string;
  execution: string;
  title: string;
  steps: string[];
  expected: string[];
  selectors: { label: string; locator: string }[];
}

function section(md: string, name: string): string {
  const re = new RegExp(`##\\s+${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  return md.match(re)?.[1] ?? "";
}

/** Parse ATC markdown back into a structure (for automate: .md → code). */
export function parseTestCaseMd(md: string): ParsedTestCase {
  const id = md.match(/^id:\s*(.+?)\s*$/m)?.[1]?.trim() ?? "";
  const execution = md.match(/^execution:\s*(.+?)\s*$/m)?.[1]?.trim() ?? "auto";
  const titleM = md.match(/^title:\s*"?(.+?)"?\s*$/m);
  const title = (titleM?.[1] ?? md.match(/^#\s+[^:\n]*:\s*(.+)$/m)?.[1] ?? "Untitled").trim();
  const steps = section(md, "Steps")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => l.replace(/^\d+\.\s*/, ""));
  const expected = section(md, "Expected Result")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
  const selectors = section(md, "Selectors")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !l.includes("---") && !/Element|Locator/i.test(l))
    .map((l) => {
      const cells = l
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      return { label: cells[0] ?? "", locator: (cells[1] ?? "").replace(/`/g, "").trim() };
    })
    .filter((s) => s.locator.length > 0);
  return { id, execution, title, steps, expected, selectors };
}
