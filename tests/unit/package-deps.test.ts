import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Dependency-hygiene invariants (0.3.3 — Playwright coexistence + optional OTel).
 *
 * These guard the two root-cause fixes against regression:
 *  - FIX A: `@playwright/cli` drags `playwright-core@…-alpha`, splitting the tree into two cores.
 *    It must NOT be a regular dependency — only an OPTIONAL peer (the experimental cli backend opts in).
 *    With it gone, `playwright` + `@playwright/test` resolve to ONE stable `playwright-core` — the same
 *    one cairn LAUNCHES and the same one `cairn install-browsers` targets.
 *  - FIX D: `@langfuse/*` + `@opentelemetry/*` must NOT be in the default install (they carry the only
 *    audit moderate + most of the footprint). They live in devDependencies (for the repo's own build)
 *    and are declared as OPTIONAL peers (the opt-in tracing contract); telemetry lazy-imports them.
 */
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const deps = pkg.dependencies ?? {};
const peers = pkg.peerDependencies ?? {};
const peerMeta = pkg.peerDependenciesMeta ?? {};

describe("single stable playwright-core invariant (FIX A)", () => {
  it("does NOT ship @playwright/cli as a regular dependency (it drags the alpha core)", () => {
    expect(deps).not.toHaveProperty("@playwright/cli");
  });

  it("still depends on the stable launch packages cairn drives at runtime", () => {
    expect(deps).toHaveProperty("playwright");
    expect(deps).toHaveProperty("@playwright/test");
  });

  it("declares @playwright/cli as an OPTIONAL peer (opt-in cli backend)", () => {
    expect(peers).toHaveProperty("@playwright/cli");
    expect(peerMeta["@playwright/cli"]?.optional).toBe(true);
  });
});

describe("optional Langfuse/OpenTelemetry (FIX D)", () => {
  const optionalScopes = ["@langfuse/", "@opentelemetry/"];
  const isOptionalScope = (name: string): boolean => optionalScopes.some((s) => name.startsWith(s));

  it("does NOT ship Langfuse/OpenTelemetry as regular dependencies", () => {
    const leaked = Object.keys(deps).filter(isOptionalScope);
    expect(leaked).toEqual([]);
  });

  it("declares them as OPTIONAL peers so tracing is an explicit opt-in", () => {
    const optionalPeers = Object.keys(peers).filter(isOptionalScope);
    expect(optionalPeers.length).toBeGreaterThan(0);
    for (const name of optionalPeers) {
      expect(peerMeta[name]?.optional).toBe(true);
    }
  });
});
