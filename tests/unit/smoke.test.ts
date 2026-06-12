import { describe, it, expect } from "vitest";
import { BOT_NAME, BOT_VERSION } from "../../src/index.js";

describe("smoke (Sprint 0)", () => {
  it("exports the package name", () => {
    expect(BOT_NAME).toBe("@plune-ai/cairn");
  });

  it("exports the version in semver format", () => {
    expect(BOT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
