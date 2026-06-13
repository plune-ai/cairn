import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainEntry } from "../../src/cli/is-main.js";

describe("isMainEntry (entry detection survives symlinked bins)", () => {
  it("argv path is a SYMLINK to the module file → true (npm link / Unix global bin)", async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), "qa-main-"));
    try {
      const real = join(dir, "index.js");
      await writeFile(real, "// entry", "utf8");
      const link = join(dir, "cairn-bin.js");
      try {
        symlinkSync(real, link);
      } catch {
        ctx.skip(); // no symlink privilege (e.g. Windows without Developer Mode)
        return;
      }
      expect(isMainEntry(link, pathToFileURL(real).href)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("argv path and module are DIFFERENT files → false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-main-"));
    try {
      const a = join(dir, "a.js");
      const b = join(dir, "b.js");
      await writeFile(a, "// a", "utf8");
      await writeFile(b, "// b", "utf8");
      expect(isMainEntry(a, pathToFileURL(b).href)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing argv or nonexistent path → false (never throws)", () => {
    expect(isMainEntry(undefined, pathToFileURL(join(tmpdir(), "x.js")).href)).toBe(false);
    expect(
      isMainEntry(join(tmpdir(), "nope-does-not-exist.js"), pathToFileURL(join(tmpdir(), "y.js")).href),
    ).toBe(false);
  });
});
