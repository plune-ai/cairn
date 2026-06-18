import { describe, it, expect } from "vitest";
import { runRepairLoop } from "../../src/agent/repair-loop.js";
import type { GeneratedSuite } from "../../src/codegen/index.js";
import type { ValidationReport } from "../../src/validate/index.js";

const report = (
  results: { test: string; status: "passed" | "failed" | "flaky"; error?: string }[],
  greenRatio: number,
): ValidationReport => ({ results, greenRatio, flakyCount: 0 });

/** Scripted generate/validate harness — no browser, no LLM. */
function harness(validations: ValidationReport[]) {
  const hints: (string | undefined)[] = [];
  let gen = 0;
  let val = 0;
  return {
    hints,
    genCount: (): number => gen,
    generate: async (hint?: string): Promise<GeneratedSuite> => {
      hints.push(hint);
      return { files: [{ path: `s${gen++}.spec.ts`, content: "// gen" }] };
    },
    validate: async (): Promise<ValidationReport> => validations[Math.min(val++, validations.length - 1)]!,
  };
}

describe("runRepairLoop (L1-04 #40 — shared validate⇄repair⇄keep-best)", () => {
  it("green on the first try → no repair (attempts 0, only the initial generate)", async () => {
    const h = harness([report([{ test: "t", status: "passed" }], 1)]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3 });
    expect(r.attempts).toBe(0);
    expect(r.bestValidation.greenRatio).toBe(1);
    expect(h.genCount()).toBe(1);
  });

  it("red → repair → green (attempts 1; the repair pass gets the failing test as a hint)", async () => {
    const h = harness([
      report([{ test: "t", status: "failed" }], 0),
      report([{ test: "t", status: "passed" }], 1),
    ]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3 });
    expect(r.attempts).toBe(1);
    expect(r.bestValidation.greenRatio).toBe(1);
    expect(h.hints[0]).toBeUndefined(); // initial generate — no hint
    expect(h.hints[1]).toContain("t"); // repair generate — failing test names
  });

  it("the repair hint carries the failing test's error (so codegen fixes the real cause, not just the name)", async () => {
    const h = harness([
      report([{ test: "TC-3", status: "failed", error: "strict mode violation: resolved to 3 elements" }], 0),
      report([{ test: "TC-3", status: "passed" }], 1),
    ]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3 });
    expect(r.attempts).toBe(1);
    expect(h.hints[1]).toContain("TC-3");
    expect(h.hints[1]).toContain("strict mode violation"); // the error reaches codegen, not just the name
  });

  it("persistent identical failures → stop early, NOT all maxRepair", async () => {
    const stuck = report([{ test: "a", status: "passed" }, { test: "b", status: "failed" }], 0.5);
    const h = harness([stuck, { ...stuck, results: [...stuck.results] }]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 5 });
    expect(r.stoppedEarly).toBe(true);
    expect(r.attempts).toBe(1); // initial + 1 no-progress repair → bail (not 5)
    expect(r.bestValidation.greenRatio).toBe(0.5);
  });

  it("keeps repairing while improving, capped by maxRepair", async () => {
    const h = harness([
      report([{ test: "a", status: "failed" }], 0.2),
      report([{ test: "a", status: "failed" }], 0.4),
      report([{ test: "a", status: "failed" }], 0.6),
    ]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 2 });
    expect(r.attempts).toBe(2);
    expect(r.stoppedEarly).toBe(false);
    expect(r.bestValidation.greenRatio).toBeCloseTo(0.6);
  });

  it("keep-best: a broken (0-test) regeneration does NOT replace the best", async () => {
    const h = harness([
      report([{ test: "a", status: "passed" }, { test: "b", status: "failed" }], 0.5),
      report([], 0), // broken regeneration
    ]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 1 });
    expect(r.bestValidation.greenRatio).toBe(0.5); // kept, not dropped to 0
    expect(r.bestSuite.files[0]?.path).toBe("s0.spec.ts"); // the first (best) suite
  });
});
