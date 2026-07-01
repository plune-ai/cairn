/**
 * C1-04 / API-9 (#146) — execute a generated {@link ApiScenario} step by step, threading captured
 * response values into downstream requests.
 *
 * Each step reuses `runApiCases` (API-3) verbatim — a resolved step IS a normal `ApiCase`, so all of
 * the runner's auth/retry/redaction/schema-assertion behaviour applies unchanged. The only new
 * behaviour here: (a) before sending a step, overwrite any of its params whose name matches a value
 * captured earlier; (b) after a step succeeds, capture values for steps still to come — preferring a
 * declared `links` expression (`ApiCase.responseLinks`) over the fallback heuristic (a response-body
 * field with the same name as the needed param); (c) a failed step aborts the rest of the scenario —
 * continuing with an unresolved captured value (e.g. a missing id after a failed create) would just
 * cascade one real failure into several meaningless ones.
 */
import { runApiCases, type ApiCaseResult, type RunnerOptions } from "./runner.js";
import type { ApiCase, ApiCaseParams } from "./cases.js";
import type { ApiScenario } from "./scenarios.js";

export interface ApiScenarioResult {
  name: string;
  steps: ApiCaseResult[];
  passed: boolean;
}

export async function runApiScenarios(scenarios: ApiScenario[], opts: RunnerOptions): Promise<ApiScenarioResult[]> {
  const results: ApiScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runOneScenario(scenario, opts));
  return results;
}

async function runOneScenario(scenario: ApiScenario, opts: RunnerOptions): Promise<ApiScenarioResult> {
  const captured: Record<string, string> = {};
  const steps: ApiCaseResult[] = [];
  let aborted = false;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    if (aborted) {
      steps.push(skippedResult(step));
      continue;
    }

    const [result] = await runApiCases([resolveParams(step, captured)], opts);
    steps.push(result!);
    if (!result!.passed) {
      aborted = true; // an earlier step in the chain failed — later steps have nothing valid to run on
      continue;
    }
    captureValues(step, result!, scenario.steps.slice(i + 1), captured);
  }

  return { name: scenario.name, steps, passed: steps.every((s) => s.passed) };
}

function skippedResult(step: ApiCase): ApiCaseResult {
  return {
    name: step.name,
    method: step.method,
    url: "",
    request: { headers: {} },
    attempts: 0,
    expectedStatus: step.expectedStatus,
    statusOk: false,
    schemaOk: false,
    schemaErrors: [],
    passed: false,
    error: "skipped — an earlier step in this scenario failed",
  };
}

/** Overwrite any param whose name matches a value captured from an earlier step. */
function resolveParams(step: ApiCase, captured: Record<string, string>): ApiCase {
  if (Object.keys(captured).length === 0) return step;
  const apply = (bucket: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...bucket };
    for (const k of Object.keys(out)) if (k in captured) out[k] = captured[k];
    return out;
  };
  const params: ApiCaseParams = {
    path: apply(step.params.path),
    query: apply(step.params.query),
    header: apply(step.params.header),
    cookie: apply(step.params.cookie),
  };
  return { ...step, params };
}

/** After a step succeeds, capture whatever later steps' params need — links first, name-match second. */
function captureValues(step: ApiCase, result: ApiCaseResult, laterSteps: ApiCase[], captured: Record<string, string>): void {
  const neededNames = new Set(
    laterSteps.flatMap((s) => [
      ...Object.keys(s.params.path),
      ...Object.keys(s.params.query),
      ...Object.keys(s.params.header),
      ...Object.keys(s.params.cookie),
    ]),
  );
  if (neededNames.size === 0) return;

  const body = result.response?.json;
  const bodyObj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;

  for (const name of neededNames) {
    const viaLink = evalLinkFor(step, name, laterSteps, body);
    if (viaLink !== undefined) {
      captured[name] = viaLink;
      continue;
    }
    if (bodyObj && name in bodyObj) captured[name] = String(bodyObj[name]);
  }
}

/** A declared `links` expression targeting one of the later steps, for the given param name. */
function evalLinkFor(step: ApiCase, paramName: string, laterSteps: ApiCase[], body: unknown): string | undefined {
  if (!step.responseLinks) return undefined;
  const laterOpIds = new Set(laterSteps.map((s) => s.operationId).filter((id): id is string => !!id));
  for (const link of Object.values(step.responseLinks)) {
    if (!link.operationId || !laterOpIds.has(link.operationId)) continue;
    const expr = link.parameters[paramName];
    if (!expr) continue;
    const val = evalResponseBodyPointer(body, expr);
    if (val !== undefined) return String(val);
  }
  return undefined;
}

/**
 * ponytail: supports only the `$response.body#/<json-pointer>` runtime-expression form (OpenAPI's
 * `links` grammar also allows `$request.*`/`$url`/etc.) — the one shape that actually matters for
 * threading a created resource's id into the next request; add more forms if a real spec needs them.
 */
function evalResponseBodyPointer(body: unknown, expr: string): unknown {
  const m = /^\$response\.body#(\/.*)$/.exec(expr);
  if (!m) return undefined;
  let cur: unknown = body;
  for (const raw of m[1]!.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
