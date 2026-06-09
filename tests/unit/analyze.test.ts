import { describe, it, expect } from "vitest";
import { analyzePage } from "../../src/analyze/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";

const study: PageStudy = {
  url: "http://x",
  screenshotB64: "B64DATA",
  ariaYaml: '- button "Go"',
  capturedBy: "lib",
  elements: [{ ref: "e1", role: "button", name: "Go", interactive: true, rank: 3 }],
};

describe("analyzePage (identifyElements)", () => {
  it("aria-only (vision=false) → semantics + grounded primaryRefs, without an image", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ pageSemantics: "Сторінка кнопки", primaryRefs: ["e1", "eGHOST"] });
    };
    const a = await analyzePage(study, {
      invoke: fakeInvoke,
      prompts: new PromptRegistry(),
      vision: false,
    });
    expect(a.pageSemantics).toBe("Сторінка кнопки");
    expect(a.primaryRefs).toEqual(["e1"]); // eGHOST filtered out (grounding)
    expect(captured).not.toContain("image_url");
  });

  it("vision=true → the message contains an image_url with the screenshot", async () => {
    let captured = "";
    const fakeInvoke: StructuredInvoke = async (schema, messages) => {
      captured = JSON.stringify(messages);
      return schema.parse({ pageSemantics: "x", primaryRefs: [] });
    };
    await analyzePage(study, { invoke: fakeInvoke, prompts: new PromptRegistry(), vision: true });
    expect(captured).toContain("image_url");
    expect(captured).toContain("B64DATA");
  });
});
