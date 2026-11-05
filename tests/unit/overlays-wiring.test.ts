import { describe, it, expect } from "vitest";
import { nameOverlays } from "../../src/agent/overlays.js";
import { designTestCases } from "../../src/design/index.js";
import { generateSuite } from "../../src/codegen/index.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import { renderReportMd, locatorFor } from "../../src/artifacts/report.js";
import { formatOverlays, type OverlayState } from "../../src/observe/overlays.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";

const study: PageStudy = {
  url: "http://x/projects",
  screenshotB64: "",
  ariaYaml: "",
  capturedBy: "lib",
  elements: [{ ref: "e2", role: "button", name: "New project", interactive: true, rank: 3 }],
};

const modal: OverlayState = {
  id: "overlay-1",
  kind: "dialog",
  role: "dialog",
  name: "New project",
  modal: true,
  trigger: { role: "button", name: "New project" },
  exits: [
    { kind: "escape", verified: true },
    { kind: "close-button", name: "Close" },
    { kind: "cancel", name: "Cancel" },
    { kind: "click-outside", verified: false },
    { kind: "submit", name: "Save", safe: true },
  ],
  elements: [{ role: "button", name: "Save", locator: "page.getByRole('dialog', { name: 'New project', exact: true }).getByRole('button', { name: 'Save', exact: true })" }],
  toasts: ["Name is required"],
  skipped: [],
};
const confirm: OverlayState = {
  ...modal,
  id: "overlay-2",
  kind: "alertdialog",
  role: "alertdialog",
  name: "Are you sure?",
  parent: "overlay-1",
  trigger: { role: "button", name: "Discard changes" },
  exits: [{ kind: "cancel", name: "Keep editing" }, { kind: "submit", name: "Yes, discard", safe: true }],
  elements: [],
  toasts: [],
};

const capture = (): { invoke: StructuredInvoke; seen: () => string } => {
  let text = "";
  return {
    invoke: (async (schema: { parse(v: unknown): unknown }, messages: unknown) => {
      text = JSON.stringify(messages);
      return schema.parse({ testCases: [], files: [{ path: "a.spec.ts", content: "// x" }] });
    }) as unknown as StructuredInvoke,
    seen: () => text,
  };
};

describe("design asks for the overlay state-transition set (#225)", () => {
  it("the prompt carries each overlay with trigger and exits, and names every case: open, cancel, Esc, save valid, save invalid, nested confirmation", async () => {
    const c = capture();
    await designTestCases(
      { study, pageSemantics: "Projects", overlays: formatOverlays([modal, confirm]) },
      { invoke: c.invoke, prompts: new PromptRegistry() },
    );
    const p = c.seen();
    expect(p).toContain("opened by: button \\\"New project\\\" on the page");
    expect(p).toContain("opened by: button \\\"Discard changes\\\" inside overlay-1");
    expect(p).toContain("escape (verified)");
    expect(p).toContain("click-outside (does not close it)");
    for (const needle of ["- open:", "- cancel:", "- Esc:", "- save valid:", "- save invalid:", "- nested confirmation:", "- wizard:"]) {
      expect(p, needle).toContain(needle);
    }
  });

  it("no overlays → none of it is in the prompt", async () => {
    const c = capture();
    await designTestCases({ study, pageSemantics: "Projects" }, { invoke: c.invoke, prompts: new PromptRegistry() });
    expect(c.seen()).not.toContain("Overlays found on the page");
  });

  it("a destructive submit is marked in the text, so it is only checked for visibility", () => {
    const text = formatOverlays([{ ...modal, exits: [{ kind: "submit", name: "Delete project", safe: false }] }]);
    expect(text).toContain('submit "Delete project" (destructive — only check it is visible)');
  });
});

describe("codegen makes a dialog its own component object (#225)", () => {
  it("the prompt asks for a component object per overlay, with locators scoped to its root", async () => {
    const c = capture();
    await generateSuite(
      {
        study,
        pageSemantics: "Projects",
        testCases: [],
        overlays: formatOverlays([modal]),
        elements: [{ ref: "e9", role: "button", name: "Save", interactive: true, rank: 3, count: 1, verified: true, scope: { role: "dialog", name: "New project" } }],
      },
      { invoke: c.invoke, prompts: new PromptRegistry() },
    );
    const p = c.seen();
    expect(p).toContain("its OWN component object in the page-object model");
    expect(p).toContain("NewProjectDialog");
    expect(p).toContain("[inside dialog \\\"New project\\\": locate it through that dialog]");
    expect(p).toContain("do not touch the page under it");
  });
});

describe("nameOverlays: the LLM names, it does not detect", () => {
  const ctx = { pageSemantics: "Projects" };
  it("sets a purpose on the overlays it knows, ignores ids it was not given, trims it", async () => {
    const invoke = (async () => ({
      overlays: [
        { id: "overlay-1", purpose: "  create a project  " },
        { id: "overlay-9", purpose: "invented" },
      ],
    })) as unknown as StructuredInvoke;
    const out = await nameOverlays([modal, confirm], ctx, { invoke, prompts: new PromptRegistry() });
    expect(out.map((s) => s.purpose)).toEqual(["create a project", undefined]);
    expect(out).toHaveLength(2);
  });

  it("a failing call leaves the states as found", async () => {
    const invoke = (async () => {
      throw new Error("llm down");
    }) as unknown as StructuredInvoke;
    expect(await nameOverlays([modal], ctx, { invoke, prompts: new PromptRegistry() })).toEqual([modal]);
  });

  it("no states → no call", async () => {
    let called = false;
    const invoke = (async () => {
      called = true;
      return { overlays: [] };
    }) as unknown as StructuredInvoke;
    await nameOverlays([], ctx, { invoke, prompts: new PromptRegistry() });
    expect(called).toBe(false);
  });
});

describe("report and locators", () => {
  it("locatorFor goes through the dialog when the element is inside one, and is unchanged otherwise", () => {
    expect(locatorFor({ ref: "e1", role: "button", name: "Save", interactive: true, rank: 3, scope: { role: "dialog", name: "New project" } })).toBe(
      "page.getByRole('dialog', { name: 'New project', exact: true }).getByRole('button', { name: 'Save', exact: true })",
    );
    expect(locatorFor({ ref: "e1", role: "button", name: "Save", interactive: true, rank: 3 })).toBe("page.getByRole('button', { name: 'Save' })");
  });

  it("report.md has an Overlays section only when overlays were found", () => {
    const base = { runId: "r", url: "u", backend: "lib", profile: "p", pageSemantics: "s", elements: [], testCases: [] };
    expect(renderReportMd(base)).not.toContain("## Overlays");
    expect(renderReportMd({ ...base, overlays: [] })).not.toContain("## Overlays");
    const md = renderReportMd({ ...base, overlays: [modal] });
    expect(md).toContain("## Overlays (1)");
    expect(md).toContain('dialog "New project"');
  });
});

describe("report: ambiguous elements (#226)", () => {
  const base = { runId: "r", url: "u", backend: "lib", profile: "p", pageSemantics: "s", elements: [], testCases: [] };
  it("no Ambiguous section when there are none", () => {
    expect(renderReportMd(base)).not.toContain("Ambiguous");
    expect(renderReportMd({ ...base, ambiguous: [] })).not.toContain("Ambiguous");
  });
  it("lists each element, says it was not clicked, and names the accessibility problem", () => {
    const md = renderReportMd({ ...base, ambiguous: [{ page: "http://x/files", role: "button", name: "Delete", count: 2 }] });
    expect(md).toContain("## Ambiguous elements (1)");
    expect(md).toContain('| http://x/files | button "Delete" | 2 |');
    expect(md).toMatch(/did not click/i);
    expect(md).toMatch(/accessib/i);
  });
});
