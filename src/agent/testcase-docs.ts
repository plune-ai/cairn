import { locatorFor } from "../artifacts/report.js";
import { renderTestCaseMd, type TestCaseDoc } from "../artifacts/testcase-md.js";
import type { TestCase } from "../design/index.js";
import type { VerifiedElement } from "../browser/types.js";

export interface TestCaseDocsResult {
  /** id + rendered ATC/MTC markdown, in input order. */
  docs: { id: string; md: string }[];
  /** Count of auto (ATC) cases. */
  autoN: number;
  /** Count of manual (MTC) cases. */
  manualN: number;
}

/**
 * Build ATC/MTC case docs (.md, with selectors) from designed cases — the shared logic behind both
 * `design` (cases-only) and `explore` (#39: explore now emits these too, so manual MTC cases are
 * visible deliverables and the auto/manual split is explicit). Pure — no I/O.
 */
export function buildTestCaseDocs(
  testCases: TestCase[],
  verified: VerifiedElement[],
  suite: string,
  hasChecklist: boolean,
): TestCaseDocsResult {
  const verifiedByRef = new Map(verified.map((v) => [v.ref, v]));
  let autoN = 0;
  let manualN = 0;
  const docs = testCases.map((tc) => {
    const manual = tc.execution === "manual";
    const n = manual ? (manualN += 1) : (autoN += 1);
    const id = `${manual ? "MTC" : "ATC"}-${suite}-${String(n).padStart(3, "0")}`;
    const automationPath = manual
      ? "— (manual, not automated)"
      : `tests/ui/${suite.toLowerCase()}/${id.toLowerCase()}.spec.ts`;
    const status = manual ? "📋 Manual" : "❌ Not implemented";
    const selectors = tc.elementRefs
      .map((r) => verifiedByRef.get(r))
      .filter((v): v is VerifiedElement => Boolean(v))
      .map((v) => ({ label: v.name ?? v.role, locator: locatorFor(v) }));
    const traceability = hasChecklist ? [{ source: "Checklist", reference: "provided plan" }] : [];
    const doc: TestCaseDoc = { id, suite, status, automationPath, selectors, traceability };
    return { id, md: renderTestCaseMd(tc, doc) };
  });
  return { docs, autoN, manualN };
}
