import { describe, it, expect } from "vitest";
import { LEXBOT_CLI_NOTICE } from "../../src/cli/branding.js";

/**
 * C0-03: `cairn` is the primary command; `lex-bot` stays as a hidden, deprecated
 * alias that prints a one-line notice before running the same code path.
 */
describe("CLI deprecation alias notice (C0-03)", () => {
  it("names the old command, points at the new one, and flags deprecation + removal", () => {
    expect(LEXBOT_CLI_NOTICE).toContain("lex-bot");
    expect(LEXBOT_CLI_NOTICE).toContain("cairn");
    expect(LEXBOT_CLI_NOTICE.toLowerCase()).toContain("deprecated");
    expect(LEXBOT_CLI_NOTICE.toLowerCase()).toMatch(/remov|release/);
  });

  it("is a single line (one-line notice)", () => {
    expect(LEXBOT_CLI_NOTICE.trimEnd()).not.toContain("\n");
  });
});
