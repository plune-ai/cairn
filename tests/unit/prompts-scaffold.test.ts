import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QA_TESTCASE_FROM_UI } from "../../src/prompts/local/qa-testcase-from-ui.js";

/** Newlines normalized: the committed .md may be checked out CRLF on Windows (git autocrlf). */
const lf = (s: string): string => s.replace(/\r\n/g, "\n");

describe("committed prompts/ scaffold (#80)", () => {
  it("prompts/qa-testcase-from-ui.md is the built-in design prompt VERBATIM (drift guard)", async () => {
    const file = await readFile(join("prompts", "qa-testcase-from-ui.md"), "utf8");
    expect(lf(file)).toBe(lf(QA_TESTCASE_FROM_UI));
  });

  it("ships the documented built-in style packs", async () => {
    for (const name of ["concise", "gherkin", "detailed-manual"]) {
      const text = await readFile(join("prompts", "styles", `${name}.md`), "utf8");
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });
});
