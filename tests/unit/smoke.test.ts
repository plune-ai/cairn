import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { BOT_NAME, BOT_VERSION } from "../../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("smoke (Sprint 0)", () => {
  it("exports the package name", () => {
    expect(BOT_NAME).toBe("@plune-ai/cairn");
  });

  it("exports the version from package.json (single source of truth — no manual drift)", () => {
    expect(BOT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BOT_VERSION).toBe(pkg.version);
  });
});
