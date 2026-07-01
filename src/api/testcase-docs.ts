/**
 * C1-04 / API-5 (#135) — build ATC case docs (.md) for the generated/run API cases: the API sibling
 * of `agent/testcase-docs.ts` (web), writing into the same `testcases/<id>.md` boundary Plune reads
 * for web runs. Every API-2 case is happy-path/auto, so these are always ATC — an MTC branch would
 * need a case that names a manual step, which no API slice produces yet.
 *
 * Provenance (aligns with BORROW-04, #91): a case's status can only read "Passed" when a same-named
 * result is present AND asserts `passed` — never inferred from the mere absence of a failure.
 */
import { renderApiTestCaseMd } from "../artifacts/testcase-md.js";
import type { ApiCase } from "./cases.js";
import type { ApiCaseResult } from "./runner.js";

export interface ApiTestCaseDocsResult {
  /** id + rendered ATC markdown, in input order. */
  docs: { id: string; md: string }[];
}

/** Pure — no I/O. `results` is absent for a cases-only (no `--base-url`) invocation. */
export function buildApiTestCaseDocs(
  cases: ApiCase[],
  results: ApiCaseResult[] | undefined,
  suite: string,
): ApiTestCaseDocsResult {
  const resultByName = new Map((results ?? []).map((r) => [r.name, r]));
  const docs = cases.map((c, i) => {
    const id = `ATC-${suite}-${String(i + 1).padStart(3, "0")}`;
    const result = resultByName.get(c.name);
    const status = !result ? "❌ Not run" : result.passed ? "✅ Passed" : "❌ Failed";
    return { id, md: renderApiTestCaseMd(c, { id, suite, status }) };
  });
  return { docs };
}
