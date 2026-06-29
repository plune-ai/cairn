import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintPage,
  buildInteractionMap,
  analysisFromMap,
  loadUnderstanding,
  saveUnderstanding,
  InteractionMapSchema,
  UNDERSTANDING_SCHEMA_VERSION,
} from "../../src/documentarian/index.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { PageAnalysis } from "../../src/analyze/index.js";
import type { VerifiedElement } from "../../src/browser/types.js";

const study: PageStudy = {
  url: "https://app/generate",
  screenshotB64: "",
  ariaYaml: '- button "Go"\n- textbox "Email"',
  capturedBy: "lib",
  elements: [
    { ref: "e1", role: "button", name: "Go", interactive: true, rank: 3 },
    { ref: "e2", role: "textbox", name: "Email", interactive: true, rank: 3 },
  ],
};
const analysis: PageAnalysis = { pageSemantics: "Generate page", primaryRefs: ["e1"], viewSwitchers: [] };
const verified: VerifiedElement[] = [
  { ref: "e1", role: "button", name: "Go", interactive: true, rank: 3, count: 1, verified: true },
  { ref: "e2", role: "textbox", name: "Email", interactive: true, rank: 3, count: 1, verified: true },
];

describe("documentarian — interaction map (#93)", () => {
  it("builds a strict-schema map: locators + role-derived candidate actions", () => {
    const fp = fingerprintPage(study);
    const map = buildInteractionMap(study, analysis, verified, [], fp);
    expect(InteractionMapSchema.safeParse(map).success).toBe(true);
    expect(map.schemaVersion).toBe(UNDERSTANDING_SCHEMA_VERSION);
    expect(map.fingerprint).toBe(fp);
    const go = map.elements.find((e) => e.ref === "e1");
    const email = map.elements.find((e) => e.ref === "e2");
    expect(go?.locator).toContain("getByRole('button'");
    expect(go?.candidateActions).toContain("click");
    expect(email?.candidateActions).toContain("fill");
  });

  it("fingerprint changes when the page (ARIA) changes — deliberate invalidation", () => {
    const fp1 = fingerprintPage(study);
    const fp2 = fingerprintPage({ ...study, ariaYaml: '- button "Different"' });
    expect(fp1).not.toBe(fp2);
  });

  it("analysisFromMap re-grounds primaryRefs against the current refs", () => {
    const map = buildInteractionMap(study, { ...analysis, primaryRefs: ["e1", "eGONE"] }, verified, [], "fp");
    const back = analysisFromMap(map, new Set(["e1"])); // eGONE no longer present
    expect(back.primaryRefs).toEqual(["e1"]);
    expect(back.pageSemantics).toBe("Generate page");
  });
});

describe("documentarian — cache load/save (#93)", () => {
  it("round-trips, hits on matching fingerprint, misses on a changed page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-doc-"));
    try {
      const fp = fingerprintPage(study);
      const map = buildInteractionMap(study, analysis, verified, [], fp);
      await saveUnderstanding(dir, map);

      // hit: same url + same fingerprint
      const hit = await loadUnderstanding(dir, study.url, fp);
      expect(hit?.pageSemantics).toBe("Generate page");

      // miss: page changed → fingerprint differs
      expect(await loadUnderstanding(dir, study.url, "deadbeef")).toBeUndefined();
      // miss: different url
      expect(await loadUnderstanding(dir, "https://app/other", fp)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing cache dir → undefined (no throw)", async () => {
    expect(await loadUnderstanding(join(tmpdir(), "no-cache-xyz"), "https://x", "fp")).toBeUndefined();
  });

  it("an old schemaVersion on disk is treated as a miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-doc-ver-"));
    try {
      const fp = fingerprintPage(study);
      const stale = { ...buildInteractionMap(study, analysis, verified, [], fp), schemaVersion: 0 };
      await saveUnderstanding(dir, stale);
      expect(await loadUnderstanding(dir, study.url, fp)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
