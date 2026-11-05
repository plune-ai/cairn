import { describe, it, expect } from "vitest";
import { makeGateway } from "../../src/browser/index.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import {
  overlayStack,
  overlayExits,
  wizardButtons,
  toastTexts,
  scopedLocator,
  topModalScope,
  isStepName,
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

  it("an exit is a whole name, never a verb followed by an object (#225 review)", () => {
    const view = overlayStack(
      `- dialog "Support":\n  - button "Close ticket"\n  - button "Close account"\n  - button "Cancel subscription"\n  - button "Not now"\n  - button "Закрити"\n  - button "Close": ×`,
    )[0]!;
    expect(overlayExits(view).map((x) => [x.kind, x.name])).toEqual([
      ["close-button", "Закрити"],
      ["close-button", "Close"],
      ["cancel", "Not now"],
    ]);
  });

  it("a wizard needs a Next and a Back or a step indicator; Continue is no Next; an alertdialog is never one (#225 review)", () => {
    const wiz = (aria: string, role?: string) => wizardButtons(parseAriaSnapshot(aria), role);
    // Next alone: a confirmation or a single form, not a wizard
    expect(wiz(`- dialog "Invite":\n  - button "Next"\n  - button "Cancel"`, "dialog")).toBeUndefined();
    // Next with a step indicator: a wizard on its first step, where Back is not shown yet
    expect(wiz(`- dialog "Setup":\n  - heading "Step 1 of 3" [level=2]\n  - button "Next"`, "dialog")).toMatchObject({ next: { name: "Next" } });
    expect(wiz(`- dialog "Setup":\n  - progressbar "Progress"\n  - button "Next"`, "dialog")).toMatchObject({ next: { name: "Next" } });
    // Continue is not a step, however the dialog looks
    expect(wiz(`- dialog "Transfer ownership? This cannot be undone.":\n  - button "Back"\n  - button "Continue"`, "dialog")).toBeUndefined();
    // an alertdialog asks to confirm; its Next is never pressed as a step
    expect(wiz(`- alertdialog "Proceed?":\n  - button "Back"\n  - button "Next"`, "alertdialog")).toBeUndefined();
  });

  it("Next and Back are whole names: «Next: place order» is no step (#225 review 2)", () => {
    for (const name of ["Next", "next", "Next ›", "Next >", "Next →", "Next »", "Далі", "Back", "‹ Back", "Previous", "Назад"]) expect(isStepName(name)).toBe(true);
    for (const name of ["Next: place order", "Next step: pay", "Next › Pay", "Back up data", "Previously ordered", "Далі — оплатити"]) expect(isStepName(name)).toBe(false);
    expect(wizardButtons(parseAriaSnapshot(`- dialog "Cart":\n  - heading "Step 2 of 2" [level=2]\n  - button "Back"\n  - button "Next: place order"`), "dialog")).toBeUndefined();
  });

  it("a disabled button is read as disabled from the snapshot", () => {
    const [next] = parseAriaSnapshot(`- button "Next" [disabled]`);
    expect(next).toMatchObject({ name: "Next", disabled: true });
  });
});

describe("which button exploration may press (#225 review)", () => {
  it("only one that announces a popup, and only after the deny-list", async () => {
    const { refusal } = await import("../../src/agent/overlays.js");
    expect(refusal({ name: "New project" }, { hasPopup: "dialog" })).toBeUndefined();
    expect(refusal({ name: "Details" }, { expanded: false })).toBeUndefined();
    expect(refusal({ name: "Filters" }, { controls: "filters" })).toBeUndefined();
    // a plain button is not pressed, whatever its name
    for (const name of ["Archive", "Continue", "Cancel subscription"]) expect(refusal({ name }, {})).toMatch(/does not say it opens anything/);
    expect(refusal({ name: "Archive" }, undefined)).toMatch(/does not say it opens anything/); // not readable (cli backend)
    // the deny-list stays on top of the allow-list
    expect(refusal({ name: "Sign out" }, { hasPopup: "menu" })).toBe("destructive");
    expect(refusal({ name: "Close account" }, { hasPopup: "dialog" })).toBe("destructive");
    expect(refusal({ name: "Save" }, { hasPopup: "dialog" })).toBe("completes the form; not pressed");
    expect(refusal({ name: "Share", disabled: true }, { hasPopup: "dialog" })).toBe("disabled; not pressed");
    // #225 review 2: a trigger that submits its form posts it, whatever it announces
    expect(refusal({ name: "Choose options" }, { hasPopup: "dialog" }, true)).toBe("submits a form");
    expect(refusal({ name: "Show extras" }, { expanded: false }, true)).toBe("submits a form");
    // #225 review 3: no name list for payments. The network guard holds every write while overlays are explored, so a
    // safe name that holds "order" is pressed like any other trigger, and «Pay» is pressed and its request stopped.
    for (const name of ["Sort order", "Order by date", "Order details", "Track order", "Display order", "Purchase history", "Upgrade guide"]) {
      expect(refusal({ name }, { hasPopup: "menu" })).toBeUndefined();
    }
  });
});

describe("a backend that cannot guard the network (#225 review 3)", () => {
  // Both ways a backend has no guard: the gateway's own (the cli backend's: it answers undefined) and no method at all.
  it.each([
    { how: "guardWrites answers undefined", noGuard: { guardWrites: async () => undefined } },
    { how: "no guardWrites", noGuard: {} },
  ])("presses no trigger and no wizard step ($how); it reads what is already open and says why", async ({ noGuard }) => {
    const { exploreOverlays } = await import("../../src/agent/overlays.js");
    // The cookie dialog leaves the page live, so its buttons are real candidates: pressed the moment a guard is assumed.
    const aria = `- main:
  - button "New project"
  - button "Pay"
- dialog "Cookies":
  - button "Close"`;
    const nonModal = ["dialog|Cookies"];
    const obs = { url: "https://app.test/", screenshotB64: "", ariaSnapshot: aria, nonModal, capturedBy: "cli" as const };
    const acts: unknown[] = [];
    const states: unknown[] = [];
    const gateway = {
      observe: async () => obs,
      act: async (a: unknown) => (acts.push(a), { ok: true }),
      verify: async () => [],
      getState: async () => (states.push(1), { visible: true, enabled: true, popup: { hasPopup: "dialog" } }),
      ...noGuard,
      session: () => {
        throw new Error("no session");
      },
      runTests: async () => {
        throw new Error("no tests");
      },
      close: async () => undefined,
    };
    const elements = parseAriaSnapshot(aria, { nonModal: new Set(nonModal) });
    expect(elements.find((e) => e.name === "New project")).toMatchObject({ role: "button", interactive: true });
    expect(elements.find((e) => e.name === "New project")!.underOverlay).toBeUndefined();
    const study = { url: obs.url, screenshotB64: "", ariaYaml: aria, elements, capturedBy: "cli" as const };
    const out = await exploreOverlays({ gateway, url: obs.url, study });

    expect(acts.filter((a) => (a as { kind: string }).kind === "click")).toEqual([]);
    expect(out.guard).toBe("none");
    expect(out.note).toMatch(/cannot guard the network/);
    expect(out.states.map((s) => [s.kind, s.name])).toEqual([["dialog", "Cookies"]]);
    expect(out.states[0]!.exits).toContainEqual({ kind: "close-button", name: "Close" });
    // no guard to ask for: its buttons are not read either (a cli backend answers every one "not visible")
    if (!("guardWrites" in noGuard)) expect(states).toEqual([]);
  });

  it("the cli gateway has no guard at all, the lib gateway has one", () => {
    expect(makeGateway({ backend: "cli" }).guardWrites).toBeUndefined();
    expect(makeGateway({ backend: "lib" }).guardWrites).toBeTypeOf("function");
  });
});

describe("what exploring says when it did less than usual (#225 review 5)", () => {
  const ONE_TRIGGER = `- main:
  - button "Open panel"`;
  const FALSE_REASON = /does not say it opens anything/;

  function fake(over: Record<string, unknown> = {}) {
    const log: string[] = [];
    const gateway = {
      observe: async () => ({ url: "https://app.test/", screenshotB64: "", ariaSnapshot: ONE_TRIGGER, capturedBy: "lib" as const }),
      act: async () => (log.push("press"), { ok: true }),
      verify: async () => [],
      getState: async () => (log.push("read"), { visible: true, enabled: true, popup: { hasPopup: "dialog" } }),
      guardWrites: async () => (log.push("guard"), { release: async () => (log.push("release"), []) }),
      session: () => {
        throw new Error("no session");
      },
      runTests: async () => {
        throw new Error("no tests");
      },
      close: async () => undefined,
      ...over,
    };
    return { gateway, log };
  }
  const explore = async (gateway: ReturnType<typeof fake>["gateway"], aria = ONE_TRIGGER) => {
    const { exploreOverlays } = await import("../../src/agent/overlays.js");
    // the cookie dialog leaves the page live: its buttons stay candidates
    const elements = parseAriaSnapshot(aria, { nonModal: new Set(["dialog|Cookies"]) });
    const study = { url: "https://app.test/", screenshotB64: "", ariaYaml: aria, elements, capturedBy: "lib" as const };
    return exploreOverlays({ gateway, url: study.url, study });
  };

  it("reads what a button announces before the guard is on, once, and presses after it", async () => {
    const { gateway, log } = fake();
    await explore(gateway);
    expect(log.slice(0, 3)).toEqual(["read", "guard", "press"]);
    expect(log.filter((l) => l === "read")).toEqual(["read"]);
    expect(log.at(-1)).toBe("release");
  });

  it.each([
    { what: "no button at all", aria: `- main:\n  - heading "Projects" [level=1]`, skipped: [] },
    { what: "only a button nothing announces", aria: `- main:\n  - button "Sort"`, state: { visible: true, enabled: true }, skipped: ["Sort"] },
  ])("$what: no second browser is started, and the result says nothing was pressed", async ({ aria, state, skipped }) => {
    const { gateway, log } = fake(state ? { getState: async () => state } : {});
    const out = await explore(gateway, aria);
    expect(log).not.toContain("guard");
    expect(out.guard).toBe("none");
    expect(out.note).toMatch(/nothing was pressed/);
    expect(out.skipped.map((s) => s.name)).toEqual(skipped);
  });

  it("a trigger announced on the page but missing where it is pressed gets its own reason", async () => {
    // the app reads what it shows through POST /graphql: stopped there, so the button never appears
    const blocked = [{ method: "POST", path: "/graphql", count: 1 }];
    const { gateway, log } = fake({
      observe: async () => ({ url: "https://app.test/", screenshotB64: "", ariaSnapshot: `- main:\n  - heading "Loading" [level=1]`, capturedBy: "lib" as const }),
      guardWrites: async () => ({ release: async () => blocked }),
    });
    const out = await explore(gateway);
    expect(log).not.toContain("press");
    expect(out.skipped).toEqual([{ role: "button", name: "Open panel", reason: expect.stringMatching(/announces .*not there/) }]);
    expect(out.skipped[0]!.reason).not.toMatch(FALSE_REASON);
    expect(out.guard).toBe("network");
    expect(out.blocked).toEqual(blocked);
    expect(out.note).toMatch(/not there/);
  });

  it.each([
    { how: "the read fails", getState: async () => Promise.reject(new Error("browser gone")) },
    { how: "the read says it is not visible, as a dead browser's does", getState: async () => ({ visible: false, enabled: false }) },
  ])("$how: an honest reason and a note, not a button that announces nothing; no second browser", async ({ getState }) => {
    const { gateway, log } = fake({ getState });
    const out = await explore(gateway);
    expect(log).not.toContain("guard");
    expect(out.skipped).toEqual([{ role: "button", name: "Open panel", reason: expect.stringContaining("could not be read") }]);
    expect(out.skipped[0]!.reason).not.toMatch(FALSE_REASON);
    expect(out.guard).toBe("none");
    expect(out.note).toMatch(/could not be read/);
  });

  it.each([
    { how: "the page does not load there", over: { observe: async () => Promise.reject(new Error("browser gone")) } },
    { how: "the press answers not ok", over: { act: async () => ({ ok: false, error: "browser gone" }) } },
    { how: "the press throws", over: { act: async () => Promise.reject(new Error("browser gone")) } },
  ])("$how: an empty result does not stay without an explanation", async ({ over }) => {
    const { gateway, log } = fake(over);
    const out = await explore(gateway);
    expect(out.guard).toBe("network");
    expect(out.states).toEqual([]);
    expect(out.blocked).toEqual([]);
    expect(out.skipped).toEqual([{ role: "button", name: "Open panel", reason: expect.stringContaining("could not be pressed") }]);
    expect(out.note).toMatch(/could not be pressed/);
    expect(log.at(-1)).toBe("release");
  });

  it.each([
    { how: "a coded error", error: Object.assign(new Error("spawn failed, token=s3cret"), { code: "ENOMEM" }), says: "ENOMEM" },
    { how: "an error with only a message", error: new Error("Unable to restore IndexedDB: token=s3cret"), says: "Error" },
    { how: "a named error", error: new TypeError("token=s3cret"), says: "TypeError" },
    { how: "a code off the pattern", error: Object.assign(new Error("x"), { code: "token=s3cret" }), says: "Error" },
    { how: "a name off the pattern", error: Object.assign(new Error("x"), { name: "token=s3cret" }), says: "unknown error" },
    { how: "a thrown string", error: "token=s3cret", says: "unknown error" },
  ])("a guard that failed to start is not a backend without one, and says only its category: $how", async ({ error, says }) => {
    const { gateway, log } = fake({ guardWrites: async () => Promise.reject(error) });
    const aria = `${ONE_TRIGGER}\n- dialog "Cookies":\n  - button "Close"`;
    const out = await explore(gateway, aria);
    expect(log).not.toContain("press");
    expect(out.guard).toBe("none");
    expect(out.note).toContain(`did not start (${says})`);
    expect(out.note).not.toMatch(/cannot guard the network/);
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(out.skipped).toEqual([{ role: "button", name: "Open panel", reason: expect.stringContaining("did not start") }]);
    expect(out.states.map((s) => s.name)).toEqual(["Cookies"]); // what is already open is still read
  });
});
