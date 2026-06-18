import { describe, it, expect } from "vitest";
import { describeBrowserState, doctorReport } from "../../src/browser/install.js";

/**
 * FIX C (0.3.3): the missing-browser diagnostics must describe CAIRN'S OWN Playwright — the single
 * playwright-core it both launches and installs against — so the fix always targets the right build
 * (the old generic `npx playwright install` hint resolved to the host project's Playwright instead).
 */
describe("describeBrowserState — what cairn launches + installs against", () => {
  it("reports cairn's own Playwright version (resolved, not 'unknown')", () => {
    const s = describeBrowserState();
    expect(s.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports a boolean install state and, when known, a string executable path", () => {
    const s = describeBrowserState();
    expect(typeof s.installed).toBe("boolean");
    if (s.executablePath !== undefined) expect(typeof s.executablePath).toBe("string");
  });
});

describe("doctorReport — actionable diagnostics", () => {
  it("always names Cairn's Playwright version and offers a way forward", () => {
    const s = describeBrowserState();
    const report = doctorReport().join("\n");
    expect(report).toContain("Playwright");
    expect(report).toContain(s.playwrightVersion);
    // When the bundled build is missing, both fixes are surfaced (installer + system Chrome).
    if (!s.installed) {
      expect(report).toContain("cairn install-browsers");
      expect(report).toContain("--channel chrome");
    }
  });
});
