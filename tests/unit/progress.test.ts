import { describe, it, expect } from "vitest";
import { progressSnapshot, madeProgress } from "../../src/agent/progress.js";
import type { ValidationReport } from "../../src/validate/index.js";

const report = (
  results: { test: string; status: "passed" | "failed" | "flaky" }[],
): ValidationReport => {
  const passed = results.filter((r) => r.status === "passed").length;
  return {
    results,
    greenRatio: results.length ? passed / results.length : 0,
    flakyCount: results.filter((r) => r.status === "flaky").length,
  };
};

describe("progressSnapshot (L1-04, Box 2)", () => {
  it("captures the green ratio and a stable failure signature", () => {
    const snap = progressSnapshot(report([
      { test: "A", status: "passed" },
      { test: "C", status: "failed" },
      { test: "B", status: "failed" },
    ]));
    expect(snap.greenRatio).toBeCloseTo(1 / 3);
    // signature is sorted → order-independent
    expect(snap.failSignature).toBe("B|C");
  });

  it("is order-independent for the same failing set", () => {
    const a = progressSnapshot(report([{ test: "Y", status: "failed" }, { test: "X", status: "failed" }]));
    const b = progressSnapshot(report([{ test: "X", status: "failed" }, { test: "Y", status: "failed" }]));
    expect(a.failSignature).toBe(b.failSignature);
  });

  it("treats undefined validation as zero-green, empty signature", () => {
    expect(progressSnapshot(undefined)).toEqual({ greenRatio: 0, failSignature: "" });
  });

  it("counts flaky as non-green (in the failure signature)", () => {
    const snap = progressSnapshot(report([{ test: "F", status: "flaky" }, { test: "P", status: "passed" }]));
    expect(snap.failSignature).toBe("F");
    expect(snap.greenRatio).toBeCloseTo(0.5);
  });
});

describe("madeProgress (L1-04, Box 2)", () => {
  it("the first attempt always counts as progress (nothing to compare)", () => {
    expect(madeProgress(undefined, { greenRatio: 0, failSignature: "B" })).toBe(true);
  });

  it("a higher green ratio is progress", () => {
    const prev = { greenRatio: 0.3, failSignature: "B|C" };
    const next = { greenRatio: 0.6, failSignature: "C" };
    expect(madeProgress(prev, next)).toBe(true);
  });

  it("a different failing set is progress (the repair changed something)", () => {
    const prev = { greenRatio: 0.5, failSignature: "B" };
    const next = { greenRatio: 0.5, failSignature: "C" };
    expect(madeProgress(prev, next)).toBe(true);
  });

  it("identical green ratio AND identical failures is NO progress → bail", () => {
    const prev = { greenRatio: 0.5, failSignature: "B" };
    const next = { greenRatio: 0.5, failSignature: "B" };
    expect(madeProgress(prev, next)).toBe(false);
  });
});
