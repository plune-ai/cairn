import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledge } from "../../src/knowledge/index.js";

describe("loadKnowledge", () => {
  it("includes global (no url) + those whose url pattern is in the URL; skips the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-know-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "global.md"), "Креденшели: admin@test / secret");
      await writeFile(join(dir, "gen.md"), "---\nurl: /generate\n---\nSubmit вимкнено доки email невалідний");
      await writeFile(join(dir, "other.md"), "---\nurl: /admin\n---\nЛише для адмінів");

      const text = await loadKnowledge(dir, "https://app/generate");
      expect(text).toContain("Креденшели"); // global always
      expect(text).toContain("Submit вимкнено"); // /generate matches
      expect(text).not.toContain("Лише для адмінів"); // /admin does not match
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no directory → ''", async () => {
    expect(await loadKnowledge(join(tmpdir(), "no-knowledge-xyz"), "https://x")).toBe("");
  });
});
