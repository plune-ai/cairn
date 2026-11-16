import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// The hosted trace viewer serves one fixed Playwright version and refuses traces recorded by a newer one,
// so the pin moves only together with the viewer.
describe("Playwright pin", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const name of ["playwright", "@playwright/test"]) {
    it(`${name} is a ~1.65. range`, () => {
      expect(
        pkg.dependencies[name],
        `${name} must stay on ~1.65.x: the hosted trace viewer is one fixed Playwright version, so change this pin only together with the viewer`,
      ).toMatch(/^~1\.65\./);
    });
  }
});
