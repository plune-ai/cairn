import { describe, it, expect } from "vitest";
import { buildTestCaseDocs } from "../../src/agent/testcase-docs.js";
import type { TestCase } from "../../src/design/index.js";
import type { VerifiedElement } from "../../src/browser/types.js";

const tc = (over: Partial<TestCase>): TestCase => ({
  id: "tc",
  title: "A case",
  technique: "exploratory",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["do it"],
  expected: "it works",
  priority: "high",
  elementRefs: [],
  ...over,
});

const verified: VerifiedElement[] = [
  { ref: "e1", role: "button", name: "Save", interactive: true, rank: 3, count: 1, verified: true },
];

describe("buildTestCaseDocs (#39 — shared ATC/MTC emission)", () => {
  it("numbers ATC and MTC independently and keeps input order", () => {
    const cases = [
      tc({ title: "Auto 1", execution: "auto" }),
      tc({ title: "Manual 1", execution: "manual" }),
      tc({ title: "Auto 2", execution: "auto" }),
    ];
    const r = buildTestCaseDocs(cases, verified, "DEMO", false);
    expect(r.autoN).toBe(2);
    expect(r.manualN).toBe(1);
    expect(r.docs.map((d) => d.id)).toEqual(["ATC-DEMO-001", "MTC-DEMO-001", "ATC-DEMO-002"]);
  });

  it("renders verified selectors (label + getByRole locator) into the markdown", () => {
    const r = buildTestCaseDocs([tc({ elementRefs: ["e1"] })], verified, "DEMO", false);
    expect(r.docs[0]?.md).toContain("page.getByRole('button', { name: 'Save' })");
    expect(r.docs[0]?.md).toContain("Save");
  });

  it("drops refs that aren't in the verified set (no hallucinated selectors)", () => {
    const r = buildTestCaseDocs([tc({ elementRefs: ["e1", "eGHOST"] })], verified, "DEMO", false);
    expect(r.docs[0]?.md).not.toContain("eGHOST");
  });

  it("marks manual cases as Manual in the doc", () => {
    const r = buildTestCaseDocs([tc({ execution: "manual" })], verified, "DEMO", false);
    expect(r.docs[0]?.id).toBe("MTC-DEMO-001");
    expect(r.docs[0]?.md.toLowerCase()).toContain("manual");
  });

  it("adds checklist traceability only when a checklist was provided", () => {
    const withCl = buildTestCaseDocs([tc({})], verified, "DEMO", true);
    const without = buildTestCaseDocs([tc({})], verified, "DEMO", false);
    expect(withCl.docs[0]?.md).toContain("Checklist");
    expect(without.docs[0]?.md).not.toContain("Checklist");
  });
});
