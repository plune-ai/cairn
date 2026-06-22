import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStyleText } from "../../src/design/style.js";

const noDir = join(tmpdir(), "cairn-no-styles-xyz");

describe("resolveStyleText (#80)", () => {
  it("resolves a named style pack to the file's text (loaded into the {{style}} slot)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-styles-"));
    try {
      await writeFile(join(dir, "concise.md"), "STYLE: terse titles, short steps.");
      const text = await resolveStyleText("concise", { stylesDir: dir });
      expect(text).toBe("STYLE: terse titles, short steps.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the inline hint for a built-in style name (no pack file)", async () => {
    const text = await resolveStyleText("happy", { stylesDir: noDir });
    expect(text).toContain("happy-path"); // styleDirective("happy")
  });

  it("unknown style with no file → empty (balanced, unchanged behavior)", async () => {
    const text = await resolveStyleText("nonexistent-style", { stylesDir: noDir });
    expect(text).toBe("");
  });

  it("undefined → empty", async () => {
    const text = await resolveStyleText(undefined, { stylesDir: noDir });
    expect(text).toBe("");
  });

  it("an explicit .md path → its text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-styles-"));
    try {
      const p = join(dir, "house.md");
      await writeFile(p, "HOUSE STYLE BODY");
      const text = await resolveStyleText(p, { stylesDir: noDir });
      expect(text).toBe("HOUSE STYLE BODY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
