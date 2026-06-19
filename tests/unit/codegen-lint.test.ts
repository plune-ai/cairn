import { describe, it, expect } from "vitest";
import { lintSuite, lintHint } from "../../src/codegen/lint.js";
import type { GeneratedSuite } from "../../src/codegen/index.js";

const suite = (content: string): GeneratedSuite => ({ files: [{ path: "a.spec.ts", content }] });

describe("lintSuite", () => {
  it("flags a CSS/locator() selector as fragile-locator", () => {
    const f = lintSuite(suite("await page.locator('#submit').click();"));
    expect(f.map((x) => x.kind)).toContain("fragile-locator");
  });

  it("flags getByTestId as prefer-role (mid, not fragile)", () => {
    const f = lintSuite(suite("await page.getByTestId('submit').click();"));
    expect(f).toHaveLength(1);
    expect(f[0]?.kind).toBe("prefer-role");
  });

  it("flags waitForTimeout and networkidle as bad-wait", () => {
    const f = lintSuite(suite("await page.waitForTimeout(500);\nawait page.waitForLoadState('networkidle');"));
    expect(f.filter((x) => x.kind === "bad-wait")).toHaveLength(2);
  });

  it("clean web-first code yields zero findings", () => {
    const f = lintSuite(suite("await expect(page.getByRole('button', { name: 'Go' })).toBeVisible();"));
    expect(f).toHaveLength(0);
  });

  it("carries the file path on each finding", () => {
    const f = lintSuite({ files: [{ path: "x/login.spec.ts", content: "page.locator('.x')" }] });
    expect(f[0]?.file).toBe("x/login.spec.ts");
  });

  it("does not flag the bare word 'networkidle' in a comment (anchored to the call form)", () => {
    expect(lintSuite(suite("// we used to call networkidle here"))).toHaveLength(0);
  });
  it("still flags waitForLoadState('networkidle')", () => {
    const f = lintSuite(suite("await page.waitForLoadState('networkidle');"));
    expect(f.filter((x) => x.kind === "bad-wait")).toHaveLength(1);
  });

  it("lintHint is empty for no findings and a bulleted block otherwise", () => {
    expect(lintHint([])).toBe("");
    const hint = lintHint([{ file: "a.spec.ts", kind: "bad-wait", detail: "waitForTimeout" }]);
    expect(hint).toContain("Flaky-hardening");
    expect(hint).toContain("[bad-wait]");
    expect(hint).toContain("a.spec.ts");
  });
});
