import { describe, it, expect } from "vitest";
import { lintSuite, lintHint, lintErrors } from "../../src/codegen/lint.js";
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

describe("lintErrors: the patterns that go into the repair loop before validation (#226)", () => {
  it("page.mouse.click is an error", () => {
    const f = lintErrors(suite("await page.mouse.click(120, 340);"));
    expect(f.map((x) => x.kind)).toEqual(["mouse-click"]);
  });

  it("force: true is an error", () => {
    const f = lintErrors(suite("await page.getByRole('button', { name: 'Go' }).click({ force: true });"));
    expect(f.map((x) => x.kind)).toEqual(["force-click"]);
  });

  it(".first() without a comment is an error", () => {
    const f = lintErrors(suite("await page.getByRole('button', { name: 'Delete' }).first().click();"));
    expect(f.map((x) => x.kind)).toEqual(["blind-position"]);
  });

  it(".nth( without a comment is an error", () => {
    const f = lintErrors(suite("await page.getByRole('row').nth(2).click();"));
    expect(f.map((x) => x.kind)).toEqual(["blind-position"]);
  });

  it(".first() / .nth() with a comment saying why — on the line or just above it — passes", () => {
    expect(lintErrors(suite("await page.getByRole('row').first().click(); // the first row is the point: sorting puts the newest on top"))).toEqual([]);
    expect(lintErrors(suite("// position is the point of the check: sorting\nawait expect(page.getByRole('row').nth(1)).toContainText('A');"))).toEqual([]);
    expect(lintErrors(suite("/* sorting: the first row is the lowest */ await expect(page.getByRole('row').first()).toContainText('A');"))).toEqual([]);
  });

  it("a comment two lines up, or an empty comment, is not a reason", () => {
    expect(lintErrors(suite("// sorting\nconst a = 1;\nawait page.getByRole('row').first().click();"))).toHaveLength(1);
    expect(lintErrors(suite("await page.getByRole('row').first().click(); //"))).toHaveLength(1);
  });

  it("the words in a comment or a string are not the calls", () => {
    expect(lintErrors(suite("// never call .first() or page.mouse.click or { force: true } blindly"))).toEqual([]);
    expect(lintErrors(suite("await page.goto('http://localhost:3000/first()');"))).toEqual([]);
  });

  it("clean code, and the warnings of lintSuite (CSS, waits), are not errors", () => {
    expect(lintErrors(suite("await expect(page.getByRole('button', { name: 'Go' })).toBeVisible();"))).toEqual([]);
    expect(lintErrors(suite("await page.locator('#x').click();\nawait page.waitForTimeout(100);"))).toEqual([]);
  });

  it("an error carries file and detail, and lintSuite reports it too (the hint of a failed suite)", () => {
    const s = { files: [{ path: "a/b.spec.ts", content: "ok\nawait page.mouse.click(1, 1);" }] };
    expect(lintErrors(s)[0]).toMatchObject({ file: "a/b.spec.ts", kind: "mouse-click" });
    expect(lintErrors(s)[0]!.detail).toContain("line 2");
    expect(lintSuite(s).map((x) => x.kind)).toContain("mouse-click");
  });
});
