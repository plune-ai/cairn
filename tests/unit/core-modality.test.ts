import { describe, it, expect } from "vitest";
import { gatedNotice } from "../../src/core/modality.js";
import { MODALITIES, getModality, runModality } from "../../src/core/registry.js";

/**
 * C1-01: a `Modality` is one kind of test artifact Cairn can generate. Today only `explore` (UI)
 * is real; ui/api/unit/docs are GATED stubs (L-G2 / #25) — discoverable placeholders with ZERO
 * generation logic. The registry is the seam every modality reuses.
 */

/** Collect what a modality would write to stdout/stderr. */
function capture(): { io: { out: (s: string) => void; err: (s: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => void out.push(s), err: (s) => void err.push(s) }, out, err };
}

describe("gatedNotice (pure)", () => {
  it("renders the canonical coming-soon line for a gated modality", () => {
    expect(gatedNotice({ name: "api", gated: true, summary: "x" })).toEqual([
      "api: coming soon — gated (see L-G2). Build by demand, one at a time.",
    ]);
  });

  it("appends the modality's hint line when present (ui → points at explore)", () => {
    const lines = gatedNotice({
      name: "ui",
      gated: true,
      summary: "x",
      hint: "For UI test generation today, use: cairn explore --url <url>",
    });
    expect(lines[0]).toBe("ui: coming soon — gated (see L-G2). Build by demand, one at a time.");
    expect(lines[1]).toBe("For UI test generation today, use: cairn explore --url <url>");
  });
});

describe("registry (C1-01)", () => {
  it("registers explore as the only REAL modality (has a run); ui/api/unit/docs are gated stubs", () => {
    const explore = getModality("explore");
    expect(explore?.gated).toBe(false);
    expect(typeof explore?.run).toBe("function");

    for (const name of ["ui", "api", "unit", "docs"]) {
      const m = getModality(name);
      expect(m, `modality ${name} should exist`).toBeDefined();
      expect(m?.gated, `${name} should be gated`).toBe(true);
      // ZERO generation logic — a gated stub must not carry a runner.
      expect(m?.run, `${name} must not carry a runner`).toBeUndefined();
    }
  });

  it("resolves the e2e alias to the ui modality", () => {
    expect(getModality("e2e")?.name).toBe("ui");
  });

  it("ui carries the explore pointer as its hint", () => {
    expect(getModality("ui")?.hint).toContain("cairn explore --url");
  });

  it("returns undefined for an unknown modality", () => {
    expect(getModality("nope")).toBeUndefined();
  });

  it("exposes exactly the four gated stubs (build-by-demand discipline)", () => {
    const gated = MODALITIES.filter((m) => m.gated).map((m) => m.name).sort();
    expect(gated).toEqual(["api", "docs", "ui", "unit"]);
  });
});

describe("runModality dispatch (C1-01)", () => {
  it("a gated modality prints the coming-soon notice and does NOT throw", async () => {
    const { io, out } = capture();
    await runModality("api", {}, io);
    expect(out.join("")).toContain("api: coming soon — gated (see L-G2). Build by demand, one at a time.");
  });

  it("dispatches through an alias (e2e → ui notice, incl. the explore pointer)", async () => {
    const { io, out } = capture();
    await runModality("e2e", {}, io);
    const text = out.join("");
    expect(text).toContain("coming soon — gated");
    expect(text).toContain("cairn explore --url");
  });

  it("throws on an unknown modality", async () => {
    const { io } = capture();
    await expect(runModality("nope", {}, io)).rejects.toThrow(/unknown modality/i);
  });
});
