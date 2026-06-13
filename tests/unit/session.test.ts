import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  looksLikeLoginPage,
  missingSessionMessage,
  expiredSessionMessage,
} from "../../src/session/index.js";
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

  it("looksLikeLoginPage: fires on a dominant sign-in element even without semantics", () => {
    // Element-name branch: a sign-in control dominates a tiny page (≤3 elements).
    expect(looksLikeLoginPage("", ["Sign in", "Email"])).toBe(true);
    // Many elements + no login hint in semantics → working page, not login.
    expect(looksLikeLoginPage("Dashboard with widgets", ["Sign in", "A", "B", "C", "D"])).toBe(false);
  });
});

describe("SessionStore.load — missing session UX (no raw ENOENT)", () => {
  it("named session that does not exist → actionable message naming the capture command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-sess-"));
    try {
      const store = new SessionStore(dir);
      const err = await store.load("myapp").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain("myapp");
      expect(err?.message).toContain("cairn session capture");
      expect(err?.message).not.toContain("ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session message helpers", () => {
  it("missingSessionMessage names the session + the fix command", () => {
    const msg = missingSessionMessage("myapp");
    expect(msg).toContain('"myapp"');
    expect(msg).toContain("cairn session capture");
    expect(msg).toContain("--name myapp");
    expect(msg).not.toContain("ENOENT");
  });

  it("expiredSessionMessage mentions expiry + re-capture (with and without a name)", () => {
    const named = expiredSessionMessage("myapp");
    expect(named.toLowerCase()).toContain("expired");
    expect(named).toContain("cairn session capture");
    expect(named).toContain("myapp");

    const anon = expiredSessionMessage();
    expect(anon.toLowerCase()).toContain("expired");
    expect(anon).toContain("cairn session capture");
  });
});

describe("SessionStore.loadFile — normalization (names vary across projects)", () => {
  async function writeRaw(obj: unknown): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "qa-sess-"));
    const file = join(dir, "raw.json");
    await writeFile(file, JSON.stringify(obj), "utf8");
    return { dir, file };
  }

  it("cookies-only file → origins padded to []", async () => {
    const { dir, file } = await writeRaw({ cookies: sample.cookies });
    try {
      expect(await new SessionStore(dir).loadFile(file)).toEqual({ cookies: sample.cookies, origins: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("origins-only file → cookies padded to []", async () => {
    const { dir, file } = await writeRaw({ origins: sample.origins });
    try {
      expect(await new SessionStore(dir).loadFile(file)).toEqual({ cookies: [], origins: sample.origins });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bare-token file (no cookies/origins) → clear error, not silent acceptance", async () => {
    const { dir, file } = await writeRaw({ token: "abc123" });
    try {
      await expect(new SessionStore(dir).loadFile(file)).rejects.toThrow(/storageState/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore.list / remove", () => {
  it("list returns saved session names (sorted); empty/missing dir → []", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-sess-"));
    try {
      const store = new SessionStore(dir);
      expect(await store.list()).toEqual([]);
      await store.save("beta", sample);
      await store.save("alpha", sample);
      expect(await store.list()).toEqual(["alpha", "beta"]);
      // a non-existent directory must not throw — just yields [].
      expect(await new SessionStore(join(dir, "nope")).list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("remove deletes a saved session (true), is a no-op for a missing one (false)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-sess-"));
    try {
      const store = new SessionStore(dir);
      await store.save("gone", sample);
      expect(await store.remove("gone")).toBe(true);
      expect(await store.exists("gone")).toBe(false);
      expect(await store.remove("gone")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
