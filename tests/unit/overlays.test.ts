import { describe, it, expect } from "vitest";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import {
  overlayStack,
  overlayExits,
  wizardButtons,
  toastTexts,
  scopedLocator,
  topModalScope,
} from "../../src/observe/overlays.js";

const PAGE = `- main:
  - heading "Projects" [level=1]
  - button "Save"
  - button "New project"
  - button "Actions"
  - status`;

const WITH_MODAL = `${PAGE}
- dialog "New project":
  - heading "New project" [level=2]
  - textbox "Project name"
  - alert: Name is required
  - button "Save"
  - button "Cancel"
  - button "Close": ×
  - button "Discard changes"`;

const NESTED = `${WITH_MODAL}
- alertdialog "Are you sure?":
  - button "Keep editing"
  - button "Yes, discard"`;

describe("elements inside a dialog carry its scope (#225)", () => {
  it("the Save in the modal and the Save on the page are two different elements", () => {
    const saves = parseAriaSnapshot(WITH_MODAL).filter((e) => e.role === "button" && e.name === "Save");
    expect(saves).toHaveLength(2);
    expect(saves[0]!.scope).toBeUndefined();
    expect(saves[1]!.scope).toEqual({ role: "dialog", name: "New project" });
  });

  it("the page's own elements are marked as lying under an open modal; the modal's are not", () => {
    const els = parseAriaSnapshot(WITH_MODAL);
    expect(els.find((e) => e.name === "New project" && e.role === "button")!.underOverlay).toBe(true);
    expect(els.find((e) => e.role === "textbox")!.underOverlay).toBeUndefined();
  });

  it("with a nested confirmation only the top of the stack is live", () => {
    const els = parseAriaSnapshot(NESTED);
    expect(els.find((e) => e.name === "Cancel")!.underOverlay).toBe(true);
    expect(els.find((e) => e.name === "Keep editing")!.underOverlay).toBeUndefined();
    expect(els.find((e) => e.name === "Keep editing")!.scope).toEqual({ role: "alertdialog", name: "Are you sure?" });
  });

  it("a dialog the DOM says is not modal leaves the page live (a cookie banner)", () => {
    const els = parseAriaSnapshot(WITH_MODAL, { nonModal: new Set(["dialog|New project"]) });
    expect(els.find((e) => e.name === "Actions")!.underOverlay).toBeUndefined();
    expect(els.find((e) => e.role === "textbox")!.scope).toEqual({ role: "dialog", name: "New project" });
  });

  it("no dialog → no scope and nothing under an overlay", () => {
    for (const e of parseAriaSnapshot(PAGE)) {
      expect(e.scope).toBeUndefined();
      expect(e.underOverlay).toBeUndefined();
    }
  });
});

describe("scopedLocator", () => {
  it("is the dialog-scoped shape when a scope is given", () => {
    expect(scopedLocator({ role: "dialog", name: "New project" }, "button", "Save")).toBe(
      "page.getByRole('dialog', { name: 'New project', exact: true }).getByRole('button', { name: 'Save', exact: true })",
    );
  });
  it("is the plain page locator without a scope", () => {
    expect(scopedLocator(undefined, "button", "Save")).toBe("page.getByRole('button', { name: 'Save', exact: true })");
  });
  it("escapes quotes", () => {
    expect(scopedLocator(undefined, "button", "It's")).toBe("page.getByRole('button', { name: 'It\\'s', exact: true })");
  });
});

describe("overlayStack: detection from ARIA only", () => {
  it("finds the modal and the nested confirmation, in stack order", () => {
    const stack = overlayStack(NESTED);
    expect(stack.map((o) => [o.kind, o.name])).toEqual([
      ["dialog", "New project"],
      ["alertdialog", "Are you sure?"],
    ]);
    expect(stack.every((o) => o.modal)).toBe(true);
    expect(topModalScope(NESTED)).toEqual({ role: "alertdialog", name: "Are you sure?" });
  });

  it("a menu and a complementary are overlays only when absent from the baseline page", () => {
    const aria = `${PAGE}
  - menu "Project actions":
    - menuitem "Rename"
  - complementary "Details panel":
    - button "Close details"`;
    expect(overlayStack(aria)).toEqual([]);
    const stack = overlayStack(aria, { baseline: PAGE });
    expect(stack.map((o) => [o.kind, o.name, o.modal])).toEqual([
      ["menu", "Project actions", false],
      ["drawer", "Details panel", false],
    ]);
    expect(stack[0]!.elements.map((e) => e.name)).toEqual(["Rename"]);
  });

  it("a complementary landmark that is on the baseline page is not a state", () => {
    const base = `${PAGE}\n  - complementary "Sidebar":\n    - link "Home"`;
    expect(overlayStack(base, { baseline: base })).toEqual([]);
  });

  it("a dialog named like a drawer is a drawer", () => {
    expect(overlayStack(`- dialog "Filters panel":\n  - button "Apply"`)[0]!.kind).toBe("drawer");
  });

  it("toasts (status, alert) are texts, never states", () => {
    const aria = `${WITH_MODAL}\n- status: Project saved\n- alert:\n  - text: Network error`;
    expect(overlayStack(aria).map((o) => o.kind)).toEqual(["dialog"]);
    expect(toastTexts(aria)).toEqual(["Name is required", "Project saved", "Network error"]);
  });
});

describe("exits and wizard buttons", () => {
  it("lists close button, cancel and submit of a dialog, and tells which submit passes the destructive filter", () => {
    const view = overlayStack(WITH_MODAL)[0]!;
    expect(overlayExits(view).map((x) => [x.kind, x.name, x.safe])).toEqual([
      ["close-button", "Close", undefined],
      ["cancel", "Cancel", undefined],
      ["submit", "Save", true],
    ]);
    const del = overlayStack(`- alertdialog "Remove it":\n  - button "Delete project"\n  - button "Cancel"`)[0]!;
    expect(overlayExits(del).find((x) => x.kind === "submit")).toMatchObject({ name: "Delete project", safe: false });
  });

  it("finds Next and Back", () => {
    const els = parseAriaSnapshot(`- dialog "Wizard":\n  - button "Back"\n  - button "Next"\n  - button "Cancel"`);
    expect(wizardButtons(els)).toMatchObject({ next: { name: "Next" }, back: { name: "Back" } });
    expect(wizardButtons(parseAriaSnapshot(WITH_MODAL))).toBeUndefined();
  });
});
