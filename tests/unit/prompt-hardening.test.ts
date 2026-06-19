import { describe, it, expect } from "vitest";
import { QA_PLAYWRIGHT_TS_WRITER } from "../../src/prompts/local/qa-playwright-ts-writer.js";

describe("qa-playwright-ts-writer prompt (flaky-hardening #57)", () => {
  it("forbids flaky waits and mandates web-first assertions", () => {
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/waitForTimeout/);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/networkidle/);
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/web-first|auto-?retr|auto-?wait/i);
  });

  it("still bans css/xpath/testid (unchanged locator discipline)", () => {
    expect(QA_PLAYWRIGHT_TS_WRITER).toMatch(/NO CSS\/XPath\/testid/);
  });
});
