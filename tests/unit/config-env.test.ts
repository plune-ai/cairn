import { describe, it, expect, vi } from "vitest";
import { createEnvReader } from "../../src/config/env.js";

/**
 * C0-06: env vars move to the CAIRN_ prefix while staying fully backward-compatible.
 * Resolution order per name: CAIRN_<name> → LEXBOT_<name> → LEX_<name> → <name> (bare/current).
 * Legacy LEX_/LEXBOT_ forms keep working but emit a one-time deprecation warning.
 */
describe("createEnvReader — CAIRN_ prefix with LEX_/LEXBOT_ back-compat (C0-06)", () => {
  it("prefers CAIRN_<name> over the bare name", () => {
    const read = createEnvReader({ CAIRN_LLM_PROFILE: "mixed", LLM_PROFILE: "anthropic" });
    expect(read("LLM_PROFILE")).toBe("mixed");
  });

  it("falls back to the bare/current name when no prefixed form exists (no warning)", () => {
    const warn = vi.fn();
    const read = createEnvReader({ LLM_PROFILE: "openrouter" }, warn);
    expect(read("LLM_PROFILE")).toBe("openrouter");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to LEXBOT_<name> and warns once, pointing at CAIRN_<name>", () => {
    const warn = vi.fn();
    const read = createEnvReader({ LEXBOT_MAX_REPAIR: "3" }, warn);
    expect(read("MAX_REPAIR")).toBe("3");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("LEXBOT_MAX_REPAIR");
    expect(warn.mock.calls[0][0]).toContain("CAIRN_MAX_REPAIR");
  });

  it("falls back to the older LEX_<name> form and warns", () => {
    const warn = vi.fn();
    const read = createEnvReader({ LEX_MAX_REPAIR: "5" }, warn);
    expect(read("MAX_REPAIR")).toBe("5");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("LEX_MAX_REPAIR");
  });

  it("CAIRN_ wins over legacy LEX_/LEXBOT_ and does not warn", () => {
    const warn = vi.fn();
    const read = createEnvReader(
      { CAIRN_LLM_PROFILE: "mixed", LEXBOT_LLM_PROFILE: "anthropic", LEX_LLM_PROFILE: "openrouter" },
      warn,
    );
    expect(read("LLM_PROFILE")).toBe("mixed");
    expect(warn).not.toHaveBeenCalled();
  });

  it("precedence: LEXBOT_ over LEX_", () => {
    const read = createEnvReader({ LEXBOT_LLM_PROFILE: "mixed", LEX_LLM_PROFILE: "openrouter" }, vi.fn());
    expect(read("LLM_PROFILE")).toBe("mixed");
  });

  it("warns only once per legacy variable (deduped per reader/process)", () => {
    const warn = vi.fn();
    const read = createEnvReader({ LEXBOT_MAX_REPAIR: "3" }, warn);
    read("MAX_REPAIR");
    read("MAX_REPAIR");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when nothing is set for the name", () => {
    const read = createEnvReader({});
    expect(read("NOPE")).toBeUndefined();
  });
});
