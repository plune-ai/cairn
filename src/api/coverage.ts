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
  const casesByKey = new Map<string, ApiCase[]>();
  for (const c of cases) {
    const key = apiEndpointKey({ method: c.method, path: c.path, operationId: c.operationId });
    const bucket = casesByKey.get(key);
    if (bucket) bucket.push(c);
    else casesByKey.set(key, [c]);
  }
  const resultByName = new Map((results ?? []).map((r) => [r.name, r]));

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

    const passed = targeting.length > 0 ? targeting.every((c) => resultByName.get(c.name)?.passed) : undefined;

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
