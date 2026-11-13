/**
 * MCP-E5 — what the run measured, per tool. The API sibling is `api/coverage.ts`; the rule is the same: a case that was
 * not sent covers nothing, and neither does one that got no answer. Only a case that was sent and judged (`passed`,
 * `failed` or `needs-review`) counts. A tool with no such case is `uncovered` and is listed by name: "not measured" is
 * never shown as covered.
 */
import { COVERAGE_GATE_EXIT_CODE } from "../api/coverage.js";
import type { Covers } from "./cases.js";
import { safeText, type McpToolEntry } from "./model.js";
import type { CaseResult } from "./runner.js";

export { COVERAGE_GATE_EXIT_CODE };
export type McpCoverageStatus = "covered" | "partial" | "uncovered";

export interface CoverableCase {
  stableId: string;
  tool: string;
  args: Record<string, unknown>;
  covers?: Covers;
}

export interface Share {
  sent: number;
  total: number;
}

export interface ToolCoverage {
  tool: string;
  status: McpCoverageStatus;
  /** Cases that were sent and judged. */
  judged: number;
  /** Declared top-level parameters that some judged case sent. */
  params: Share;
  /** Enum values (of the cases generated) that some judged case sent. */
  enumValues: Share;
  /** oneOf/anyOf branches (of the cases generated) that some judged case sent. */
  branches: Share;
}

export interface McpCoverageReport {
  toolCount: number;
  coveredCount: number;
  partialCount: number;
  uncoveredCount: number;
  /** covered / tools; 0 when there are no tools (nothing measured is not full coverage). */
  ratio: number;
  tools: ToolCoverage[];
  /** The tools with no judged case, by name. */
  notMeasured: string[];
}

export const JUDGED_STATES = new Set(["passed", "failed", "needs-review"]);

const own = (o: unknown): string[] => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []);

export function computeMcpCoverage(tools: readonly McpToolEntry[], cases: readonly CoverableCase[], results: readonly CaseResult[]): McpCoverageReport {
  const judgedIds = new Set(results.filter((r) => JUDGED_STATES.has(r.state)).map((r) => r.stableId));
  const out: ToolCoverage[] = tools.map((t) => {
    const mine = cases.filter((c) => c.tool === t.name);
    const judged = mine.filter((c) => judgedIds.has(c.stableId));
    const declared = new Set(own((t.inputSchema as { properties?: unknown }).properties));
    const sentParams = new Set<string>();
    for (const c of judged) for (const k of Object.keys(c.args)) if (declared.has(k)) sentParams.add(k);
    const enumKey = (x: Covers): string => `${x.param ?? ""}\u0000${x.enumValue ?? ""}`;
    const allEnum = new Set(mine.flatMap((c) => (c.covers?.enumValue !== undefined ? [enumKey(c.covers)] : [])));
    const sentEnum = new Set(judged.flatMap((c) => (c.covers?.enumValue !== undefined ? [enumKey(c.covers)] : [])));
    const allBranch = new Set(mine.flatMap((c) => (c.covers?.branch !== undefined ? [c.covers.branch] : [])));
    const sentBranch = new Set(judged.flatMap((c) => (c.covers?.branch !== undefined ? [c.covers.branch] : [])));
    const params = { sent: sentParams.size, total: declared.size };
    const enumValues = { sent: sentEnum.size, total: allEnum.size };
    const branches = { sent: sentBranch.size, total: allBranch.size };
    const complete = params.sent === params.total && enumValues.sent === enumValues.total && branches.sent === branches.total;
    const status: McpCoverageStatus = judged.length === 0 ? "uncovered" : complete ? "covered" : "partial";
    return { tool: t.name, status, judged: judged.length, params, enumValues, branches };
  });
  const count = (s: McpCoverageStatus): number => out.filter((x) => x.status === s).length;
  return {
    toolCount: tools.length,
    coveredCount: count("covered"),
    partialCount: count("partial"),
    uncoveredCount: count("uncovered"),
    ratio: tools.length === 0 ? 0 : count("covered") / tools.length,
    tools: out,
    notMeasured: out.filter((x) => x.status === "uncovered").map((x) => x.tool),
  };
}

export interface McpCoverageGate {
  passed: boolean;
  counted: number;
  total: number;
  percent: number;
  threshold: number;
  countPartial: boolean;
  /** The tools that are not counted, in the order listed. */
  missing: ToolCoverage[];
}

/** `--min-coverage`: the share of covered tools (and partial ones with `--count-partial`). No tools never passes. */
export function evaluateMcpGate(report: McpCoverageReport, threshold: number, countPartial = false): McpCoverageGate {
  const counted = report.coveredCount + (countPartial ? report.partialCount : 0);
  const total = report.toolCount;
  const percent = total === 0 ? 0 : (counted * 100) / total;
  return {
    passed: total > 0 && Math.round(percent * 1e6) >= Math.round(threshold * 1e6),
    counted,
    total,
    percent,
    threshold,
    countPartial,
    missing: report.tools.filter((x) => x.status === "uncovered" || (x.status === "partial" && !countPartial)),
  };
}

export function renderMcpCoverage(c: McpCoverageReport, gate?: McpCoverageGate): string[] {
  const lines = [`=== Coverage: ${c.coveredCount}/${c.toolCount} tool(s) covered, ${c.partialCount} partial, ${c.uncoveredCount} not measured ===`];
  for (const t of c.tools) {
    lines.push(`  ${t.status.padEnd(9)} ${safeText(t.tool, 60)} — params ${t.params.sent}/${t.params.total}, enum values ${t.enumValues.sent}/${t.enumValues.total}, branches ${t.branches.sent}/${t.branches.total}, judged cases ${t.judged}`);
  }
  if (c.notMeasured.length) lines.push(`  Not measured (no case was sent and judged): ${c.notMeasured.map((x) => safeText(x, 60)).join(", ")}`);
  if (gate) {
    lines.push(`=== Coverage gate: ${gate.passed ? "passed" : "FAILED"} — ${gate.counted}/${gate.total} tool(s) = ${Math.floor(gate.percent * 10) / 10}% (min ${gate.threshold}%) ===`);
    if (!gate.passed) for (const m of gate.missing) lines.push(`  ✗ ${m.status.padEnd(9)} ${safeText(m.tool, 60)}`);
  }
  return lines;
}
