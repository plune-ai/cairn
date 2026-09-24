import { describe, it, expect, vi } from "vitest";
import { runRepairLoop, failedTestsHint } from "../../src/agent/repair-loop.js";
import type { TriageResult } from "../../src/decider/uses/repair-triage.js";
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

  it("with a lint dep, appends lint findings to the repair hint, keeping the failure cause (#57)", async () => {
    const h = harness([
      report([{ test: "t", status: "failed", error: "boom" }], 0),
      report([{ test: "t", status: "passed" }], 1),
    ]);
    const lint = (): string => "Flaky-hardening — fix these fragile patterns:\n- [bad-wait] s0.spec.ts: waitForTimeout";
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3, lint });
    expect(r.bestValidation.greenRatio).toBe(1);
    expect(h.hints[1]).toContain("t: boom");        // #73 failure cause preserved
    expect(h.hints[1]).toContain("Flaky-hardening"); // #57 lint findings appended
  });

  it("without a lint dep, the repair hint is byte-identical to failedTestsHint (#73 guard)", async () => {
    const h = harness([
      report([{ test: "t", status: "failed", error: "boom" }], 0),
      report([{ test: "t", status: "passed" }], 1),
    ]);
    await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3 });
    expect(h.hints[1]).toBe("- t: boom"); // nothing appended
  });
});

describe("runRepairLoop with repair-triage (ADR-0022, spec §6.1)", () => {
  const two = report(
    [
      { test: "a", status: "failed", error: "500 Internal Server Error" },
      { test: "b", status: "failed", error: "Timeout 5000ms exceeded" },
    ],
    0,
  );
  const tr = (test: string, category: TriageResult["category"], exclude: boolean): TriageResult => ({
    test,
    category,
    confidence: 0.9,
    exclude,
  });

  it("failedTestsHint without triage (or with an empty one) is byte-identical to today's", () => {
    expect(failedTestsHint(two.results, new Map())).toBe(failedTestsHint(two.results));
    expect(failedTestsHint(two.results)).toBe("- a: 500 Internal Server Error\n- b: Timeout 5000ms exceeded");
  });

  it("an excluded test leaves the hint and is reported as not repaired; a confident category tags the rest", async () => {
    const h = harness([two, report([{ test: "a", status: "failed", error: "500 Internal Server Error" }, { test: "b", status: "passed" }], 0.5)]);
    const triage = vi.fn(async () => [tr("a", "app-bug", true), tr("b", "timing", false)]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 1, triage });
    expect(h.hints[1]).toBe("- b [triage: timing]: Timeout 5000ms exceeded");
    expect(r.notRepaired).toEqual([tr("a", "app-bug", true)]);
    expect(r.attempts).toBe(1);
  });

  it("triage answers nothing confident → the hint is exactly today's", async () => {
    const h = harness([two, report([{ test: "a", status: "passed" }, { test: "b", status: "passed" }], 1)]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 1, triage: async () => [] });
    expect(h.hints[1]).toBe(failedTestsHint(two.results));
    expect("notRepaired" in r).toBe(false);
  });

  it("everything excluded → the loop ends before spending an attempt, and says why", async () => {
    const h = harness([two]);
    const progress: string[] = [];
    const r = await runRepairLoop({
      generate: h.generate,
      validate: h.validate,
      maxRepair: 3,
      onProgress: (e) => progress.push(e),
      triage: async () => [tr("a", "app-bug", true), tr("b", "env-or-session", true)],
    });
    expect(r.attempts).toBe(0);
    expect(h.genCount()).toBe(1); // only the initial generation
    expect(r.notRepaired).toHaveLength(2);
    expect(progress.join("\n")).toMatch(/repair — skipped: .*2 failing test/);
  });

  it("a test excluded once is not sent to the decider again while it fails the same way", async () => {
    const still = report(
      [
        { test: "a", status: "failed", error: "500 Internal Server Error" },
        { test: "b", status: "failed", error: "Timeout 2" },
      ],
      0.1,
    );
    const h = harness([
      two,
      still,
      report([{ test: "a", status: "failed", error: "500 Internal Server Error" }, { test: "b", status: "passed" }], 0.5),
    ]);
    const triage = vi.fn(async (failedTests: { test: string }[]) =>
      failedTests.map((t) => (t.test === "a" ? tr("a", "app-bug", true) : tr("b", "timing", false))),
    );
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 2, triage });
    expect(triage.mock.calls[0]![0].map((t) => t.test)).toEqual(["a", "b"]);
    expect(triage.mock.calls[1]![0].map((t) => t.test)).toEqual(["b"]);
    expect(h.hints[2]).toBe("- b [triage: timing]: Timeout 2");
    expect(r.notRepaired).toEqual([tr("a", "app-bug", true)]);
  });

  it("green on the first try → triage is never called", async () => {
    const h = harness([report([{ test: "t", status: "passed" }], 1)]);
    const triage = vi.fn(async () => []);
    await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3, triage });
    expect(triage).not.toHaveBeenCalled();
  });

  /** A decider that calls a 500 an app bug and anything else a locator problem. */
  const byError = () =>
    vi.fn(async (failed: ValidationReport["results"]) =>
      failed.map((r) => (r.error?.startsWith("500") ? tr(r.test, "app-bug", true) : tr(r.test, "locator-missing", false))),
    );

  it("an excluded test that passes after a repair is not reported as not repaired", async () => {
    const h = harness([two, report([{ test: "a", status: "passed" }, { test: "b", status: "passed" }], 1)]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 3, triage: byError() });
    expect(r.bestValidation.greenRatio).toBe(1);
    expect("notRepaired" in r).toBe(false);
  });

  it("a test whose failure changed is asked about again — a stale verdict never keeps it out of repair", async () => {
    const script = [
      two,
      report([{ test: "a", status: "passed" }, { test: "b", status: "failed", error: "Timeout 5000ms exceeded" }], 0.5),
      report([{ test: "a", status: "failed", error: "locator resolved to 0 elements" }, { test: "b", status: "passed" }], 0.5),
      report([{ test: "a", status: "passed" }, { test: "b", status: "passed" }], 1),
    ];
    const withTriage = harness(script);
    const triage = byError();
    const r = await runRepairLoop({ generate: withTriage.generate, validate: withTriage.validate, maxRepair: 3, triage });
    const without = await runRepairLoop({ ...harness(script), maxRepair: 3 });
    expect(r.attempts).toBe(without.attempts); // 3: the same convergence as without a decider
    expect(r.bestValidation.greenRatio).toBe(1);
    // b failed the same way twice: asked once, its verdict still tags the second hint. a's new failure is asked anew.
    expect(triage.mock.calls.map((c) => c[0].map((t) => `${t.test}|${t.error}`))).toEqual([
      ["a|500 Internal Server Error", "b|Timeout 5000ms exceeded"],
      ["a|locator resolved to 0 elements"],
    ]);
    expect(withTriage.hints[2]).toBe("- b [triage: locator-missing]: Timeout 5000ms exceeded");
    expect(withTriage.hints[3]).toBe("- a [triage: locator-missing]: locator resolved to 0 elements");
    expect("notRepaired" in r).toBe(false);
  });

  it("Not repaired comes from the KEPT suite, not the last one: a test passing there is not listed", async () => {
    const h = harness([
      report([{ test: "a", status: "failed", error: "500 Internal Server Error" }, { test: "b", status: "failed", error: "locator X" }], 0),
      report([{ test: "a", status: "passed" }, { test: "b", status: "failed", error: "locator X2" }], 0.5), // kept
      report([{ test: "a", status: "failed", error: "500 Internal Server Error (2)" }, { test: "b", status: "failed", error: "locator X3" }], 0),
    ]);
    const triage = byError();
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 2, triage });
    expect(r.bestValidation.greenRatio).toBe(0.5);
    expect("notRepaired" in r).toBe(false); // a fails with a 500 in the LAST validation only
    expect(triage).toHaveBeenCalledTimes(2); // the two loop heads; the discarded last suite is never asked about
  });

  it("after the loop only tests excluded earlier are asked: a new failure in the kept suite was never kept out of repair", async () => {
    const h = harness([
      report(
        [
          { test: "a", status: "failed", error: "500 Internal Server Error" },
          { test: "b", status: "failed", error: "locator X" },
          { test: "c", status: "passed" },
          { test: "d", status: "failed", error: "locator Y" },
        ],
        0.25,
      ),
      // kept AND last: b now fails with a 500 (it had a locator verdict), c fails for the first time
      report(
        [
          { test: "a", status: "passed" },
          { test: "b", status: "failed", error: "500 boom" },
          { test: "c", status: "failed", error: "500 new" },
          { test: "d", status: "passed" },
        ],
        0.5,
      ),
    ]);
    const triage = byError();
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 1, triage });
    expect(r.bestValidation.greenRatio).toBe(0.5);
    expect(triage).toHaveBeenCalledTimes(1); // the loop head only
    expect("notRepaired" in r).toBe(false);
  });

  it("a failure is asked once: a doubt that sent it to repair is not overturned by a later answer", async () => {
    // a's "locator X" gets no confident answer at the first head; any later ask would call it an app bug.
    const seen = new Set<string>();
    const triage = vi.fn(async (failed: ValidationReport["results"]) =>
      failed.flatMap((r) => {
        const key = `${r.test}|${r.error}`;
        const first = !seen.has(key);
        seen.add(key);
        if (r.error?.startsWith("500") || (!first && r.test === "a")) return [tr(r.test, "app-bug", true)];
        return r.test === "a" ? [] : [tr(r.test, "locator-missing", false)];
      }),
    );
    const h = harness([
      report([{ test: "a", status: "failed", error: "locator X" }, { test: "b", status: "failed", error: "locator Y" }, { test: "c", status: "passed" }], 0.34),
      report([{ test: "a", status: "failed", error: "500 boom" }, { test: "b", status: "failed", error: "locator Y" }, { test: "c", status: "failed", error: "locator Z" }], 0),
      report([{ test: "a", status: "failed", error: "500 boom" }, { test: "b", status: "failed", error: "locator Y2" }, { test: "c", status: "failed", error: "locator Z" }], 0),
    ]);
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 2, triage });
    expect(r.bestValidation.greenRatio).toBe(0.34); // the kept suite is the first: a failed there with "locator X"
    // b's "locator Y" is not asked twice; after the loop, a's "locator X" (the kept suite's) is not asked again.
    expect(triage.mock.calls.map((c) => c[0].map((t) => `${t.test}|${t.error}`))).toEqual([
      ["a|locator X", "b|locator Y"],
      ["a|500 boom", "c|locator Z"],
    ]);
    expect("notRepaired" in r).toBe(false); // a went into repair on "locator X" — it is not reported as excluded
  });

  it("the kept suite is the last, never-triaged one: an excluded test failing there with reworded text is asked once more and still reported", async () => {
    const run = (a: string, b: "passed" | "failed", c: "passed" | "failed", green: number) =>
      report(
        [
          { test: "a", status: "failed", error: `500 Internal Server Error (${a})` },
          { test: "b", status: b, ...(b === "failed" ? { error: "locator resolved to 0 elements" } : {}) },
          { test: "c", status: c, ...(c === "failed" ? { error: "locator resolved to 0 elements" } : {}) },
        ],
        green,
      );
    const h = harness([run("9 × retried", "failed", "failed", 0), run("8 × retried", "passed", "failed", 0.34), run("7 × retried", "passed", "passed", 0.67)]);
    const triage = byError();
    const r = await runRepairLoop({ generate: h.generate, validate: h.validate, maxRepair: 2, triage });
    expect(r.bestValidation.greenRatio).toBe(0.67); // the last validation is the kept one
    expect(triage.mock.calls.at(-1)![0]).toEqual([expect.objectContaining({ test: "a", error: "500 Internal Server Error (7 × retried)" })]);
    expect(r.notRepaired).toEqual([expect.objectContaining({ test: "a", category: "app-bug" })]);
  });
});
