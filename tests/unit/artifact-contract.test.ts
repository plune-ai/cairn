import { describe, expect, it } from "vitest";
import { ARTIFACT_SCHEMA_VERSION, stableCaseId } from "../../src/artifacts/contract.js";
import { partialReportPayload } from "../../src/agent/summary.js";
import { parseTestCaseMd, renderTestCaseMd } from "../../src/artifacts/testcase-md.js";
import type { TestCase } from "../../src/design/schema.js";

const aCase = (over: Partial<TestCase> = {}): TestCase => ({
  id: "tc-1",
  stableId: "unset",
  title: "Subscribe with a valid email",
  technique: "equivalence-partitioning",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["Open the page", "Enter an email", "Submit"],
  expected: "A confirmation appears",
  priority: "high",
  elementRefs: [],
  ...over,
});

describe("stableCaseId (identity that survives a re-run)", () => {
  it("is the same for the same substance", () => {
    expect(stableCaseId(["Login", "boundary", "works"])).toBe(stableCaseId(["Login", "boundary", "works"]));
  });

  it("ignores casing and whitespace noise, which are not a new case", () => {
    expect(stableCaseId(["  Login   works ", "boundary"])).toBe(stableCaseId(["login works", "BOUNDARY"]));
  });

  it("changes when the substance changes", () => {
    expect(stableCaseId(["Login works"])).not.toBe(stableCaseId(["Logout works"]));
  });

  // The separator, not the concatenation, is what keeps these apart — a space-joined hash would
  // make one part "ab c" collide with two parts "ab" + "c".
  it("does not let a regrouping of the same text collide", () => {
    expect(stableCaseId(["ab c"])).not.toBe(stableCaseId(["ab", "c"]));
  });

  it("skips empty and missing parts instead of hashing them as content", () => {
    expect(stableCaseId(["Login", undefined, "  "])).toBe(stableCaseId(["Login"]));
  });

  it("is short and hex — an id a human can compare by eye", () => {
    expect(stableCaseId(["anything"])).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("partial artifact (a failed run is still an artifact someone parses)", () => {
  it("carries the version and the kind of run, not just the failure", () => {
    const p = partialReportPayload({ runId: "r1", url: "https://x", mode: "design", error: "boom" });
    expect(p).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      mode: "design",
      partial: true,
      error: "boom",
    });
  });

  it("omits the kind when the caller genuinely does not know it, rather than inventing one", () => {
    expect(partialReportPayload({ runId: "r1", url: "https://x", error: "boom" })).not.toHaveProperty("mode");
  });
});

describe("case file carries both identities", () => {
  const doc = {
    id: "ATC-PAGE-UI-001",
    suite: "PAGE-UI",
    status: "✅ Passed",
    automationPath: "tests/x.spec.ts",
    selectors: [],
    traceability: [],
  };

  it("writes the run-local id AND the cross-run identity", () => {
    const md = renderTestCaseMd(aCase({ stableId: "abc123def456" }), doc);
    expect(md).toContain("id: ATC-PAGE-UI-001");
    expect(md).toContain("stableId: abc123def456");
  });

  it("round-trips both through the parser", () => {
    const parsed = parseTestCaseMd(renderTestCaseMd(aCase({ stableId: "abc123def456" }), doc));
    expect(parsed.id).toBe("ATC-PAGE-UI-001");
    expect(parsed.stableId).toBe("abc123def456");
  });

  // `^id:` must not swallow the `stableId:` line — that would silently replace the run-local id with
  // a hash and break `promote`/`automate`, which match on the ATC-<suite>-<n> shape.
  it("does not let the stableId line be read as the id", () => {
    const parsed = parseTestCaseMd(renderTestCaseMd(aCase({ stableId: "abc123def456" }), doc));
    expect(parsed.id).not.toBe("abc123def456");
  });

  it("reports an empty identity for a file written before the field existed", () => {
    expect(parseTestCaseMd("---\nid: ATC-X-001\nexecution: auto\n---\n").stableId).toBe("");
  });
});
