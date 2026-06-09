import { describe, it, expect } from "vitest";
import { classifyRuns } from "../../src/validate/index.js";

describe("classifyRuns (flaky classification, Spike S4)", () => {
  it("all runs passed → passed, greenRatio 1", () => {
    const r = classifyRuns([
      [{ title: "a", status: "passed" }],
      [{ title: "a", status: "passed" }],
    ]);
    expect(r.results[0]?.status).toBe("passed");
    expect(r.greenRatio).toBe(1);
    expect(r.flakyCount).toBe(0);
  });

  it("all failures (failed/timedOut) → failed, greenRatio 0", () => {
    const r = classifyRuns([
      [{ title: "a", status: "failed" }],
      [{ title: "a", status: "timedOut" }],
    ]);
    expect(r.results[0]?.status).toBe("failed");
    expect(r.greenRatio).toBe(0);
  });

  it("mixed (pass+fail) → flaky, not green", () => {
    const r = classifyRuns([
      [{ title: "a", status: "passed" }],
      [{ title: "a", status: "failed" }],
    ]);
    expect(r.results[0]?.status).toBe("flaky");
    expect(r.flakyCount).toBe(1);
    expect(r.greenRatio).toBe(0);
  });

  it("multiple tests → greenRatio = passed/total", () => {
    const r = classifyRuns([
      [
        { title: "a", status: "passed" },
        { title: "b", status: "failed" },
      ],
    ]);
    expect(r.greenRatio).toBe(0.5);
  });
});
