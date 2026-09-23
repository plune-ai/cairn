import { describe, it, expect } from "vitest";
import { loadConfig, parseDeciderConfig } from "../../src/config/index.js";
import { createEnvReader } from "../../src/config/env.js";
import { resolveConfig } from "../../src/core/config.js";

const BASE = { ANTHROPIC_API_KEY: "sk-ant" };
const parse = (env: Record<string, string | undefined>) => parseDeciderConfig(createEnvReader(env, () => undefined));

describe("decider config — opt-in only (ADR-0022)", () => {
  it("unset or off → no decider, and AppConfig has no `decider` key at all", () => {
    expect(parse({})).toBeUndefined();
    expect(parse({ DECIDER: "off" })).toBeUndefined();
    expect(parse({ DECIDER: " OFF " })).toBeUndefined();
    expect("decider" in loadConfig(BASE)).toBe(false);
    expect("decider" in loadConfig({ ...BASE, DECIDER: "off" })).toBe(false);
  });

  it("a key alone enables nothing", () => {
    expect(parse({ TYPESAFE_API_KEY: "k", LAYA_API_KEY: "l", DECIDER_API_KEY: "d", DECIDER_BASE_URL: "http://x.test" })).toBeUndefined();
  });

  it("jev: defaults and its own key", () => {
    expect(parse({ DECIDER: "jev", TYPESAFE_API_KEY: "k" })).toEqual({
      provider: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKey: "k",
      uses: ["repair-triage", "coverage"],
      minConfidence: 0.75,
      timeoutMs: 10000,
      maxCalls: 200,
    });
    expect(loadConfig({ ...BASE, DECIDER: "jev", TYPESAFE_API_KEY: "k" }).decider?.provider).toBe("jev");
  });

  it("jev without a key fails at start, naming the variable", () => {
    expect(() => parse({ DECIDER: "jev" })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => loadConfig({ ...BASE, DECIDER: "jev" })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("laya/compat need DECIDER_BASE_URL", () => {
    expect(() => parse({ DECIDER: "laya" })).toThrow(/DECIDER_BASE_URL/);
    expect(() => parse({ DECIDER: "compat" })).toThrow(/DECIDER_BASE_URL/);
    expect(parse({ DECIDER: "laya", DECIDER_BASE_URL: "http://127.0.0.1:8000" })).toMatchObject({
      provider: "laya",
      baseUrl: "http://127.0.0.1:8000",
      model: "jev-latest",
    });
  });

  it("each provider reads only its own key — a TypeSafe key never goes to laya or compat", () => {
    const env = {
      TYPESAFE_API_KEY: "cloud",
      LAYA_API_KEY: "local",
      DECIDER_API_KEY: "other",
      DECIDER_BASE_URL: "http://127.0.0.1:8000",
    };
    expect(parse({ ...env, DECIDER: "laya" })?.apiKey).toBe("local");
    expect(parse({ ...env, DECIDER: "compat" })?.apiKey).toBe("other");
    expect(parse({ DECIDER: "compat", TYPESAFE_API_KEY: "cloud", DECIDER_BASE_URL: "http://x.test" })).not.toHaveProperty(
      "apiKey",
    );
    expect(parse({ DECIDER: "laya", TYPESAFE_API_KEY: "cloud", DECIDER_BASE_URL: "http://x.test" })).not.toHaveProperty(
      "apiKey",
    );
  });

  it("every variable reads with the CAIRN_ prefix too", () => {
    const d = parse({
      CAIRN_DECIDER: "laya",
      CAIRN_DECIDER_BASE_URL: "http://127.0.0.1:8000",
      CAIRN_DECIDER_MIN_CONFIDENCE: "0.9",
      CAIRN_LAYA_API_KEY: "l",
      CAIRN_DECIDER_USES: "coverage",
      CAIRN_DECIDER_MODEL: "multilingual",
      CAIRN_DECIDER_TIMEOUT_MS: "5000",
      CAIRN_DECIDER_MAX_CALLS: "3",
    });
    expect(d).toEqual({
      provider: "laya",
      baseUrl: "http://127.0.0.1:8000",
      model: "multilingual",
      apiKey: "l",
      uses: ["coverage"],
      minConfidence: 0.9,
      timeoutMs: 5000,
      maxCalls: 3,
    });
  });

  it("DECIDER_USES: dedups, trims, and an empty value means the default", () => {
    expect(parse({ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_USES: " coverage , coverage,repair-triage " })?.uses).toEqual([
      "coverage",
      "repair-triage",
    ]);
    expect(parse({ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_USES: "" })?.uses).toEqual(["repair-triage", "coverage"]);
  });

  it.each([
    [{ DECIDER: "gpt" }, /Invalid DECIDER='gpt'/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_USES: "repair-traige" }, /Unknown DECIDER_USES entry 'repair-traige'/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_USES: "judge" }, /supported in this version/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_MIN_CONFIDENCE: "1.5" }, /DECIDER_MIN_CONFIDENCE/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_MIN_CONFIDENCE: "high" }, /DECIDER_MIN_CONFIDENCE/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_TIMEOUT_MS: "0" }, /DECIDER_TIMEOUT_MS/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_TIMEOUT_MS: "1.5" }, /DECIDER_TIMEOUT_MS/],
    [{ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_MAX_CALLS: "-1" }, /DECIDER_MAX_CALLS/],
    [{ DECIDER: "laya", DECIDER_BASE_URL: "not a url" }, /DECIDER_BASE_URL/],
    [{ DECIDER: "laya", DECIDER_BASE_URL: "ftp://127.0.0.1" }, /DECIDER_BASE_URL/],
  ])("rejects %o", (env, msg) => {
    expect(() => parse(env)).toThrow(msg);
  });

  it("the --decider flag beats the environment — including CAIRN_DECIDER", () => {
    const env = { ...BASE, CAIRN_DECIDER: "jev", TYPESAFE_API_KEY: "k" };
    expect(resolveConfig({}, env).decider?.provider).toBe("jev");
    expect("decider" in resolveConfig({ decider: "off" }, env)).toBe(false);
    expect(resolveConfig({ decider: "laya" }, { ...env, DECIDER_BASE_URL: "http://127.0.0.1:8000" }).decider?.provider).toBe(
      "laya",
    );
  });

  it("resolveConfig never mutates the env it was given", () => {
    const env = { ...BASE };
    resolveConfig({ decider: "off" }, env);
    expect(env).toEqual(BASE);
  });
});
