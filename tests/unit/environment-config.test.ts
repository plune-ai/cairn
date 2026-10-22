import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment, parseEnvironment, resolveEnvironment } from "../../src/environment/config.js";
import { EnvironmentConfigError } from "../../src/environment/errors.js";
import { configContent } from "../../src/validate/runner.js";

const file = (obj: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), "cairn-env-")), "env.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

describe("environment description", () => {
  it("no file and no CAIRN_ENV_* ⇒ undefined (old behavior untouched)", async () => {
    expect(await loadEnvironment({ env: {} })).toBeUndefined();
  });

  it("loads a file and lets CAIRN_ENV_* override it", async () => {
    const f = file({ baseUrl: "https://a.example.com", startPath: "/old", user: { usernameVar: "U", passwordVar: "P" } });
    const env = await loadEnvironment({ file: f, env: { CAIRN_ENV_START_PATH: "/new", CAIRN_ENV_LOGIN_PATH: "/signin" } });
    expect(env?.startPath).toBe("/new");
    expect(env?.user?.loginPath).toBe("/signin");
  });

  it("works from environment variables alone", async () => {
    const env = await loadEnvironment({
      env: { CAIRN_ENV_BASE_URL: "https://a.example.com", CAIRN_ENV_BASIC_AUTH_USER_VAR: "BU", CAIRN_ENV_BASIC_AUTH_PASSWORD_VAR: "BP" },
    });
    expect(env?.basicAuth).toEqual({ usernameVar: "BU", passwordVar: "BP" });
  });

  it("login path defaults to /login", () => {
    const env = parseEnvironment({ baseUrl: "https://a.example.com", user: { usernameVar: "U", passwordVar: "P" } });
    expect(env.user?.loginPath).toBe("/login");
  });

  it("rejects a secret written into the file, without echoing it", () => {
    for (const bad of [
      { baseUrl: "https://a.example.com", password: "Sup3rS3cret!" },
      { baseUrl: "https://a.example.com", basicAuth: { usernameVar: "BU", passwordVar: "Sup3rS3cret!" } },
      { baseUrl: "https://bob:Sup3rS3cret!@a.example.com" },
      { baseUrl: "https://a.example.com", user: { usernameVar: "U", passwordVar: "P", token: "Sup3rS3cret!" } },
    ]) {
      let msg = "";
      try {
        parseEnvironment(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(EnvironmentConfigError);
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain("Sup3rS3cret!");
    }
  });

  it("resolves secrets from the environment; a missing variable is named, never a value", () => {
    const env = parseEnvironment({ baseUrl: "https://a.example.com", basicAuth: { usernameVar: "BU", passwordVar: "BP" } });
    expect(() => resolveEnvironment(env, { BU: "bob" })).toThrow(/BP/);
    const r = resolveEnvironment(env, { BU: "bob", BP: "pa55word" });
    expect(r.basicAuth).toEqual({ username: "bob", password: "pa55word" });
    expect(r.secrets).toContain("pa55word");
  });

  it("the generated Playwright config reads Basic Auth from process.env — the values are not in the file", () => {
    const cfg = configContent("/r", undefined, undefined, 1, undefined, { usernameVar: "BU", passwordVar: "BP" });
    expect(cfg).toContain('process.env["BU"]');
    expect(cfg).toContain('process.env["BP"]');
    expect(configContent("/r")).not.toContain("httpCredentials");
  });
});
