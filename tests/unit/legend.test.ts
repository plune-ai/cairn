import { describe, it, expect } from "vitest";
import { METRIC_LEGEND, dirGlyph } from "../../src/eval/legend.js";

describe("METRIC_LEGEND / dirGlyph", () => {
  it("dirGlyph: up → ↑, down → ↓, unknown → ''", () => {
    expect(dirGlyph("grounding")).toBe("↑");
    expect(dirGlyph("runs_green")).toBe("↑");
    expect(dirGlyph("case_redundancy")).toBe("↓");
    expect(dirGlyph("flaky_ratio")).toBe("↓");
    expect(dirGlyph("totally_unknown")).toBe("");
  });

  it("only case_redundancy and flaky_ratio are 'lower is better' (guards the README note)", () => {
    const down = Object.entries(METRIC_LEGEND)
      .filter(([, m]) => m.dir === "down")
      .map(([k]) => k)
      .sort();
    expect(down).toEqual(["case_redundancy", "flaky_ratio"]);
  });

  it("every entry has a non-empty blurb and a known kind", () => {
    for (const [name, m] of Object.entries(METRIC_LEGEND)) {
      expect(m.blurb, name).not.toBe("");
      expect(["deterministic", "judge"], name).toContain(m.kind);
    }
  });

  it("the three judge metrics are exactly the LLM-scored ones", () => {
    const judge = Object.entries(METRIC_LEGEND)
      .filter(([, m]) => m.kind === "judge")
      .map(([k]) => k)
      .sort();
    expect(judge).toEqual(["checklist_coverage", "methodology_adherence", "test_case_quality"]);
  });
});
