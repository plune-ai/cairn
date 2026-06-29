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

      const text = await loadKnowledge(dir, { url: "https://app/generate" });
      expect(text).toContain("Креденшели"); // global always
      expect(text).toContain("Submit вимкнено"); // /generate matches
      expect(text).not.toContain("Лише для адмінів"); // /admin does not match
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no directory → ''", async () => {
    expect(await loadKnowledge(join(tmpdir(), "no-knowledge-xyz"), { url: "https://x" })).toBe("");
  });

  // BORROW-03 (#92): scope-aware injection — web | api | all.
  describe("scope-aware injection (#92)", () => {
    async function fixture(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "qa-know-scope-"));
      await mkdir(join(dir, "api"), { recursive: true });
      // base dir → web by default; explicit scope: all for shared creds; api subdir → api by default.
      await writeFile(join(dir, "web-page.md"), "---\nurl: /generate\n---\nWEB-ONLY note");
      await writeFile(join(dir, "creds.md"), "---\nscope: all\n---\nSHARED creds admin@test/secret");
      await writeFile(join(dir, "api", "users.md"), "---\nendpoint: /users\n---\nAPI-ONLY note");
      return dir;
    }

    it("web run injects web+all, NOT api", async () => {
      const dir = await fixture();
      try {
        const text = await loadKnowledge(dir, { scope: "web", url: "https://app/generate" });
        expect(text).toContain("WEB-ONLY"); // web file matched
        expect(text).toContain("SHARED creds"); // all available to web
        expect(text).not.toContain("API-ONLY"); // api hidden from web
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("api run injects api+all, NOT web", async () => {
      const dir = await fixture();
      try {
        const text = await loadKnowledge(dir, { scope: "api", endpoint: "https://app/api/users" });
        expect(text).toContain("API-ONLY"); // api file matched by endpoint
        expect(text).toContain("SHARED creds"); // all available to api
        expect(text).not.toContain("WEB-ONLY"); // web hidden from api
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("a base-dir file without scope: stays web (back-compat default)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "qa-know-bc-"));
      try {
        await writeFile(join(dir, "legacy.md"), "---\nurl: /generate\n---\nLEGACY note");
        // visible to a web run…
        expect(await loadKnowledge(dir, { url: "https://app/generate" })).toContain("LEGACY");
        // …and NOT to an api run (it is web-scoped by default, not all).
        expect(await loadKnowledge(dir, { scope: "api", endpoint: "/generate" })).not.toContain("LEGACY");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("an unknown/empty scope: value falls back to the directory default", async () => {
      const dir = await mkdtemp(join(tmpdir(), "qa-know-bad-"));
      try {
        await writeFile(join(dir, "weird.md"), "---\nscope: nonsense\n---\nWEIRD note");
        // unknown scope → directory default (base = web)
        expect(await loadKnowledge(dir, { scope: "web" })).toContain("WEIRD");
        expect(await loadKnowledge(dir, { scope: "api" })).not.toContain("WEIRD");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
