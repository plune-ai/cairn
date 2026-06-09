import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, looksLikeLoginPage } from "../../src/session/index.js";
import type { StorageState } from "../../src/browser/types.js";

const sample: StorageState = {
  cookies: [{ name: "qa_demo", value: "1", domain: "127.0.0.1", path: "/" }],
  origins: [
    { origin: "http://127.0.0.1", localStorage: [{ name: "qa_session", value: "active" }] },
  ],
};

describe("SessionStore", () => {
  it("save → load round-trips (cookies + localStorage)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-sess-"));
    try {
      const store = new SessionStore(dir);
      await store.save("demo", sample);
      expect(await store.exists("demo")).toBe(true);
      expect(await store.load("demo")).toEqual(sample);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("load of a nonexistent session throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-sess-"));
    try {
      await expect(new SessionStore(dir).load("nope")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isValid: valid state → true; garbage → false", () => {
    const store = new SessionStore(tmpdir());
    expect(store.isValid(sample)).toBe(true);
    expect(store.isValid({})).toBe(false);
    expect(store.isValid(null)).toBe(false);
    expect(store.isValid({ cookies: [], origins: "x" })).toBe(false);
  });

  it("looksLikeLoginPage: login screen → true; working page → false", () => {
    expect(looksLikeLoginPage("Це екран для входу через Google", ["Sign in with Google"])).toBe(true);
    expect(
      looksLikeLoginPage("Сторінка генерації CV", ["Generate CV", "Text", "URL", "File", "Log out"]),
    ).toBe(false);
  });
});
