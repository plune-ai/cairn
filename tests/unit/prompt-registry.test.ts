import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptRegistry } from "../../src/prompts/index.js";

describe("PromptRegistry", () => {
  it("without a fetcher → local prompt (fallback), version 'local', with interpolation", async () => {
    const reg = new PromptRegistry();
    const p = await reg.getPrompt("identify-elements", { ariaYaml: "ARIA_X", elements: "ELS_Y" });
    expect(p.isFallback).toBe(true);
    expect(p.version).toBe("local");
    expect(p.text).toContain("QA engineer");
    expect(p.text).toContain("ARIA_X");
  });

  it("interpolation: missing variable → empty", async () => {
    const reg = new PromptRegistry({ local: { t: "a {{x}} b {{y}}" } });
    const p = await reg.getPrompt("t", { x: "1" });
    expect(p.text).toBe("a 1 b ");
  });

  it("unknown name → throws", async () => {
    await expect(new PromptRegistry({ local: {} }).getPrompt("nope")).rejects.toThrow();
  });

  it("with a fetcher → uses the remote one (version number, isFallback false)", async () => {
    const reg = new PromptRegistry({
      fetcher: { fetch: async () => ({ text: "remote {{x}}", version: 7 }) },
      local: { t: "local" },
    });
    const p = await reg.getPrompt("t", { x: "Z" });
    expect(p.isFallback).toBe(false);
    expect(p.version).toBe(7);
    expect(p.text).toBe("remote Z");
  });

  it("fetcher throws → fallback to local", async () => {
    const reg = new PromptRegistry({
      fetcher: {
        fetch: async () => {
          throw new Error("net down");
        },
      },
      local: { t: "local {{x}}" },
    });
    const p = await reg.getPrompt("t", { x: "Q" });
    expect(p.isFallback).toBe(true);
    expect(p.text).toBe("local Q");
  });

  it("an .md override in overridesDir overrides the local constant + interpolates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-prompts-"));
    try {
      await writeFile(join(dir, "qa-testcase-from-ui.md"), "ОВЕРРАЙД для {{pageSemantics}}");
      const reg = new PromptRegistry({ overridesDir: dir });
      const p = await reg.getPrompt("qa-testcase-from-ui", { pageSemantics: "Форма" });
      expect(p.text).toBe("ОВЕРРАЙД для Форма");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no .md override → local constant", async () => {
    const reg = new PromptRegistry({ overridesDir: join(tmpdir(), "no-prompts-xyz-123") });
    const p = await reg.getPrompt("identify-elements", {});
    expect(p.text.length).toBeGreaterThan(0);
  });
});
