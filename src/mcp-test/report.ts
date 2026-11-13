/**
 * MCP-E5 — what a run leaves on disk: `report.json` (the shape `cairn api` writes, with `mode: "mcp"`), `report.md`,
 * `mcp-evidence.json` and the ATC case documents. Each part is built on its own, so a failure in one loses that part and
 * nothing else; the caller records which part was lost (see {@link settle}).
 */
import { ARTIFACT_SCHEMA_VERSION } from "../artifacts/contract.js";
import { renderMcpTestCaseMd } from "../artifacts/testcase-md.js";
import { type McpCoverageGate, type McpCoverageReport, renderMcpCoverage, COVERAGE_GATE_EXIT_CODE } from "./coverage.js";
import type { McpGuardReport } from "./guard.js";
import { safeText } from "./model.js";
import { CASE_STATES, type CaseResult, type CaseState, type RunnableCase } from "./runner.js";

export const NOTHING_PROVEN_EXIT_CODE = 5;
export const BUDGET_EXIT_CODE = 4;

export interface Finding {
  kind: "anonymous-call-succeeded";
  tool: string;
}

export function countStates(results: readonly CaseResult[]): Record<CaseState, number> {
  const out = Object.fromEntries(CASE_STATES.map((s) => [s, 0])) as Record<CaseState, number>;
  for (const r of results) out[r.state] += 1;
  return out;
}

/**
 * 1 when a case failed or the run was stopped before the end; 3 when coverage fell short; 4 when a budget ran out;
 * 5 when nothing was proven (no case passed); 0 otherwise. A run in which every answer needed a person is not green.
 */
export function mcpExitCode(o: { results: readonly CaseResult[]; stopped?: string; gate?: McpCoverageGate; budgetExhausted: boolean }): number {
  const n = countStates(o.results);
  if (n.failed > 0 || o.stopped) return 1;
  if (o.gate && !o.gate.passed) return COVERAGE_GATE_EXIT_CODE;
  if (o.budgetExhausted) return BUDGET_EXIT_CODE;
  if (n.passed === 0) return NOTHING_PROVEN_EXIT_CODE;
  return 0;
}

export function buildEvidence(results: readonly CaseResult[]): unknown[] {
  return results.map((r) => ({
    name: r.name,
    stableId: r.stableId,
    tool: r.tool,
    passed: r.state === "passed",
    state: r.state,
    reason: r.reason,
    ...(r.error ? { error: r.error } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.request !== undefined ? { request: r.request } : {}),
    ...(r.response !== undefined ? { response: r.response } : {}),
    ...(r.responseBytes !== undefined ? { responseBytes: r.responseBytes } : {}),
    ...(r.truncated ? { truncated: true } : {}),
    observations: r.observations,
    advice: r.advice,
    ...(r.humanOracle ? { humanOracle: true } : {}),
  }));
}

export interface ReportInput {
  runId: string;
  /** The address, or the server command's name without arguments; no secret. */
  url: string;
  results: readonly CaseResult[];
  cases: readonly RunnableCase[];
  toolCount: number;
  guard: McpGuardReport;
  coverage?: McpCoverageReport;
  gate?: McpCoverageGate;
  findings: readonly Finding[];
  stopped?: string;
  /** Parts that could not be built, by name. */
  lost: readonly string[];
}

export function buildReportJson(r: ReportInput): unknown {
  const n = countStates(r.results);
  const sent = r.results.length - n["not-sent"];
  const byName = new Map(r.results.map((x) => [x.name, x]));
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    runId: r.runId,
    url: r.url,
    mode: "mcp",
    mcp: { passed: n.passed, total: sent, toolCount: r.toolCount },
    states: n,
    guardrails: r.guard,
    cases: r.cases.map((c) => ({
      name: c.name,
      stableId: c.stableId,
      tool: c.tool,
      kind: c.kind,
      type: c.type,
      ...(c.technique ? { technique: c.technique } : {}),
      ...(c.rationale ? { rationale: c.rationale } : {}),
      ...(c.style ? { adversarialStyle: c.style } : {}),
      state: byName.get(c.name)?.state ?? "not-sent",
    })),
    ...(r.coverage ? { coverage: r.coverage } : {}),
    ...(r.gate ? { coverageGate: r.gate } : {}),
    findings: r.findings,
    ...(r.stopped ? { stopped: r.stopped } : {}),
    ...(r.lost.length ? { lost: r.lost } : {}),
    cost: { usd: 0, tokens: 0, model: false },
  };
}

const ICON: Record<CaseState, string> = { passed: "✓", failed: "✗", "not-sent": "⊘", "could-not-run": "?", "needs-review": "!" };

export function renderMcpReportMd(r: ReportInput): string {
  const n = countStates(r.results);
  const lines = ["# Cairn — MCP run report", ""];
  lines.push(`- **Server:** ${safeText(r.url, 200)}`, `- **Run ID:** ${r.runId}`);
  lines.push(`- **Cases:** ${n.passed} passed, ${n.failed} failed, ${n["needs-review"]} need review, ${n["could-not-run"]} could not run, ${n["not-sent"]} not sent`);
  if (r.stopped) lines.push(`- **Stopped early:** ${safeText(r.stopped, 200)}`);
  if (n["needs-review"]) lines.push(`- **${n["needs-review"]} case(s) were answered but not judged: a person has to look.**`);
  if (r.lost.length) lines.push(`- **Not built:** ${r.lost.join(", ")}`);
  lines.push("", `## Cases (${r.results.length})`, "", "| state | tool | case | why |", "|---|---|---|---|");
  for (const x of r.results) lines.push(`| ${ICON[x.state]} ${x.state} | ${safeText(x.tool, 60)} | ${safeText(x.name, 120)} | ${safeText(x.reason, 160)} |`);
  lines.push("");
  const advice = r.results.filter((x) => x.advice.length);
  if (advice.length) {
    lines.push("## Advice (heuristics; they change no state and no exit code)", "");
    for (const x of advice) lines.push(`- ${safeText(x.name, 120)}: ${x.advice.map((a) => `${a.kind} (line ${a.line})`).join(", ")}`);
    lines.push("");
  }
  if (r.findings.length) {
    lines.push("## Findings", "");
    for (const f of r.findings) lines.push(`- ${f.kind}: ${safeText(f.tool, 60)}`);
    lines.push("");
  }
  if (r.coverage) lines.push(...renderMcpCoverage(r.coverage, r.gate).map((l) => (l.startsWith("=== ") ? `## ${l.slice(4, -4)}` : l)), "");
  return lines.join("\n");
}

/** ATC documents, one per case; "Passed" only when that case's own result says passed. */
export function buildMcpTestCaseDocs(cases: readonly RunnableCase[], results: readonly CaseResult[], suite: string): Array<{ id: string; md: string }> {
  const byName = new Map(results.map((x) => [x.name, x]));
  return cases.map((c, i) => {
    const id = `ATC-${suite}-${String(i + 1).padStart(3, "0")}`;
    const state = byName.get(c.name)?.state;
    const status = state === "passed" ? "✅ Passed" : state === "failed" ? "❌ Failed" : state === "needs-review" ? "⚠ Needs review" : "❌ Not run";
    return { id, md: renderMcpTestCaseMd(c, { id, suite, status }) };
  });
}

/** Runs one optional part: a failure is recorded in `lost` and the rest of the run goes on. */
export function settle<T>(label: string, lost: string[], fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    lost.push(`${label} (${safeText((e as Error).message, 80)})`);
    return undefined;
  }
}
