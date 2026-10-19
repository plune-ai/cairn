/**
 * C1-04 / API-6 (#136) — spec-vs-tested coverage report (`playswag`-style, borrowed from
 * AZANIR/qa-skills): given the ingested {@link ApiModel} (API-1) and the generated/executed cases
 * (API-2/API-3), report which spec operations are untested, and which are only partially exercised.
 *
 * "Partial" falls naturally out of the data already on hand: an operation can declare several
 * responses (200, 404, 500…), but every case generated so far (API-2) targets exactly one status —
 * the happy path. So an operation is `covered` only when every response IT declares has a matching
 * case, `partial` when some (but not all) are exercised, and `uncovered` when none are. Grouping by
 * declared-vs-tested statuses (not raw case count) means this keeps working once later slices (API-8
 * contract/negative cases, API-9 scenarios) generate more than one case per operation — no rework
 * needed here. An operation declaring zero responses (malformed but parseable) has nothing to miss —
 * vacuously `covered`, the same "nothing observed → nothing left uncovered" convention
 * `eval/coverage.ts` already uses for its ratio.
 *
 * Pure set arithmetic (no LLM, no I/O) — the API sibling of `eval/coverage.ts` (web gap-analysis).
 */
import { apiEndpointKey, type ApiCase } from "./cases.js";
import type { ApiEndpoint, ApiModel } from "./openapi.js";
import type { ApiCaseResult } from "./runner.js";

export type ApiCoverageStatus = "covered" | "partial" | "uncovered";

export interface ApiEndpointCoverage {
  method: string;
  path: string;
  operationId?: string;
  deprecated: boolean;
  status: ApiCoverageStatus;
  /** Every status the spec declares for this operation ("200","404",…). */
  declaredStatuses: string[];
  /** The subset of `declaredStatuses` some generated case actually targets. */
  testedStatuses: string[];
  /** Whether the run (if one happened) passed — undefined when no `--base-url` execution occurred. */
  passed?: boolean;
}

export interface ApiCoverageReport {
  endpointCount: number;
  coveredCount: number;
  partialCount: number;
  uncoveredCount: number;
  /** coveredCount / endpointCount (1 when the spec has no operations, never NaN). */
  ratio: number;
  /** Every operation, in the model's order — filter by `status` for a gaps-only view. */
  endpoints: ApiEndpointCoverage[];
}

/**
 * Coverage = for each spec operation, which of its declared response statuses a generated case
 * exercises. `results` is optional — a cases-only invocation (no `--base-url`) still gets a
 * meaningful report, just without the per-endpoint pass/fail overlay.
 */
export function computeApiCoverage(
  model: ApiModel,
  cases: ApiCase[],
  results?: ApiCaseResult[],
): ApiCoverageReport {
  const resultByName = new Map((results ?? []).map((r) => [r.name, r]));
  const casesByKey = new Map<string, ApiCase[]>();
  for (const c of cases) {
    // A case the guardrails kept off the wire (#196) was described, not tested: it covers nothing.
    const r = resultByName.get(c.name);
    if (r && (r.skipped || r.blocked)) continue;
    const key = apiEndpointKey({ method: c.method, path: c.path, operationId: c.operationId });
    const bucket = casesByKey.get(key);
    if (bucket) bucket.push(c);
    else casesByKey.set(key, [c]);
  }

  let coveredCount = 0;
  let partialCount = 0;
  let uncoveredCount = 0;
  const endpoints = model.endpoints.map((e): ApiEndpointCoverage => {
    const key = apiEndpointKey(e);
    const targeting = casesByKey.get(key) ?? [];
    const declaredStatuses = [...new Set(e.responses.map((r) => r.status))];
    const testedStatuses = declaredStatuses.filter((s) => targeting.some((c) => c.expectedStatus === s));

    // A malformed-but-parseable operation with no declared responses has nothing to miss — vacuously
    // "covered" (same convention `eval/coverage.ts` uses: ratio is 1 when nothing was observed).
    const status: ApiCoverageStatus =
      declaredStatuses.length === 0 || testedStatuses.length === declaredStatuses.length
        ? "covered"
        : testedStatuses.length === 0
          ? "uncovered"
          : "partial";
    if (status === "covered") coveredCount += 1;
    else if (status === "partial") partialCount += 1;
    else uncoveredCount += 1;

    // A case the guardrails kept off the wire (#196) says nothing about pass/fail — leave it out of the overlay.
    const ran = targeting.filter((c) => !resultByName.get(c.name)?.skipped && !resultByName.get(c.name)?.blocked);
    const passed = ran.length > 0 ? ran.every((c) => resultByName.get(c.name)?.passed) : undefined;

    return endpointCoverage(e, status, declaredStatuses, testedStatuses, results ? passed : undefined);
  });

  return {
    endpointCount: model.endpoints.length,
    coveredCount,
    partialCount,
    uncoveredCount,
    ratio: model.endpoints.length === 0 ? 1 : coveredCount / model.endpoints.length,
    endpoints,
  };
}

function endpointCoverage(
  e: ApiEndpoint,
  status: ApiCoverageStatus,
  declaredStatuses: string[],
  testedStatuses: string[],
  passed: boolean | undefined,
): ApiEndpointCoverage {
  return {
    method: e.method,
    path: e.path,
    operationId: e.operationId,
    deprecated: e.deprecated,
    status,
    declaredStatuses,
    testedStatuses,
    ...(passed !== undefined ? { passed } : {}),
  };
}

/** Process exit code when `--min-coverage` is not reached (1 stays "a test failed / bad input"). */
export const COVERAGE_GATE_EXIT_CODE = 3;

export interface CoverageGateResult {
  passed: boolean;
  /** Operations counted as covered (`covered`, plus `partial` with `--count-partial`). */
  counted: number;
  total: number;
  /** counted / total as a percentage (100 when the spec has no operations). */
  percent: number;
  threshold: number;
  countPartial: boolean;
  /** Operations that are not counted, in the model's order — the reason for a failed gate. */
  missing: ApiEndpointCoverage[];
}

/**
 * Parse the `--min-coverage` value: a number from 0 to 100 (a trailing `%` is tolerated). Anything
 * else throws a message that names the flag and the value, so a typo cannot silently disable the gate.
 */
export function parseMinCoverage(raw: unknown): number {
  const text = typeof raw === "string" ? raw.trim() : raw;
  // Strings: plain decimal digits with an optional trailing % (no signs, exponents, hex, "Infinity").
  const n =
    typeof text === "number" ? text : typeof text === "string" && /^\d+(\.\d+)?%?$/.test(text) ? Number(text.replace(/%$/, "")) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`--min-coverage must be a number from 0 to 100 (got "${String(raw)}").`);
  }
  return n;
}

/** Compare the share of covered operations (optionally + partial) with the threshold. Pure. */
export function evaluateCoverageGate(
  report: ApiCoverageReport,
  threshold: number,
  countPartial = false,
): CoverageGateResult {
  const counted = report.coveredCount + (countPartial ? report.partialCount : 0);
  const total = report.endpointCount;
  // Compare on 1e-6 integers so a fractional threshold (79.9) meets its exact fraction (799 / 1000).
  const passed = total === 0 || Math.round(((counted * 100) / total) * 1e6) >= Math.round(threshold * 1e6);
  return {
    passed,
    counted,
    total,
    percent: total === 0 ? 100 : (counted * 100) / total,
    threshold,
    countPartial,
    missing: report.endpoints.filter((e) => e.status === "uncovered" || (e.status === "partial" && !countPartial)),
  };
}

/** Floor to one decimal, so 79.96% is never shown as "80%" next to a threshold of 80. */
const shownPercent = (p: number): string => `${Math.floor(p * 10 + 1e-9) / 10}%`;

/** Render the `--min-coverage` verdict: "n / N", the percentage, and the operations that are not counted. */
export function renderCoverageGate(g: CoverageGateResult): string[] {
  const counted = g.countPartial ? "covered + partial" : "covered";
  const lines = [
    "",
    `=== Coverage gate: ${g.passed ? "passed" : "FAILED"} — ${g.counted} / ${g.total} operation(s) ${counted} = ${shownPercent(g.percent)} (min ${g.threshold}%) ===`,
  ];
  if (!g.passed) {
    for (const e of g.missing) {
      const op = e.operationId ? ` (${e.operationId})` : "";
      lines.push(`  ✗ ${e.status.padEnd(9)} ${e.method.padEnd(6)} ${e.path}${op}`);
    }
  }
  return lines;
}
