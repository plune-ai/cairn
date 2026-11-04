import { describe, it, expect } from "vitest";
import { clickEffect, clickFailure, recordedPath } from "../../src/browser/click-effect.js";

/** A page's ARIA snapshot, before or after a click. */
const page = (...lines: string[]): string => ["- main:", '  - heading "Orders" [level=1]', ...lines].join("\n");
const base = { page: "http://app.test/orders", url: "http://app.test/orders", role: "button", name: "Save", requests: [] };

describe("clickEffect — what a click changed, as one name from a closed set (#224)", () => {
  it("a new URL → navigated; the next page is not diffed against this one", () => {
    const e = clickEffect({ ...base, url: "http://app.test/orders/7", before: page(), after: page("  - text: other page") });
    expect(e.outcome).toBe("navigated");
    expect(e.url).toBe("http://app.test/orders/7");
    expect(e.added).toEqual([]);
  });

  it("a dialog that appears → overlay-opened, a menu that goes away → overlay-closed", () => {
    const opened = clickEffect({ ...base, before: page(), after: page('  - dialog "Edit order":', '    - button "Close"') });
    expect(opened.outcome).toBe("overlay-opened");
    expect(opened.opened).toEqual(['dialog "Edit order"']);
    const closed = clickEffect({ ...base, before: page('  - menu "Actions":', '    - menuitem "Copy"'), after: page() });
    expect(closed.outcome).toBe("overlay-closed");
    expect(closed.closed).toEqual(['menu "Actions"']);
    // A menuitem or a menubar is not an overlay of its own.
    expect(clickEffect({ ...base, before: page(), after: page('  - menubar "Main"') }).opened).toEqual([]);
  });

  it("the element's own checked / expanded / pressed / selected → state-changed", () => {
    const e = clickEffect({ ...base, role: "checkbox", name: "Remember me", before: page('  - checkbox "Remember me"'), after: page('  - checkbox "Remember me" [checked]') });
    expect(e.outcome).toBe("state-changed");
    expect(e.state).toEqual([{ attr: "checked", before: "false", after: "true" }]);
    const menu = clickEffect({ ...base, name: "More", before: page('  - button "More" [expanded]'), after: page('  - button "More"') });
    expect(menu.state).toEqual([{ attr: "expanded", before: "true", after: "false" }]);
  });

  it("other ARIA lines that changed → content-changed, with the lines", () => {
    const e = clickEffect({ ...base, before: page('  - status: ""'), after: page("  - status: Saved") });
    expect(e.outcome).toBe("content-changed");
    expect(e.added).toEqual(["- status: Saved"]);
    expect(e.removed).toEqual(['- status: ""']);
  });

  it("nothing visible, but a request answered 2xx → network-only (a silent save is an effect)", () => {
    const e = clickEffect({ ...base, before: page(), after: page(), requests: [{ method: "POST", path: "/api/orders", status: 201 }] });
    expect(e.outcome).toBe("network-only");
  });

  it("nothing changed at all → no-effect; a failed or unanswered request is not an effect either", () => {
    expect(clickEffect({ ...base, before: page(), after: page() }).outcome).toBe("no-effect");
    const requests = [{ method: "POST", path: "/api/orders", status: 500 }, { method: "GET", path: "/api/slow" }];
    expect(clickEffect({ ...base, before: page(), after: page(), requests }).outcome).toBe("no-effect");
  });
});

/** Call logs as Playwright 1.61 writes them (one with its terminal colour codes left in). */
const resolved = "  - waiting for getByRole('button', { name: 'Save', exact: true }).first()\n    - locator resolved to <button>Save</button>\n  - attempting click action\n";
const log = (tail: string): string => `locator.click: Timeout 2000ms exceeded.\nCall log:\n${resolved}${tail}`;

describe("clickFailure — the cause instead of a timeout (#224)", () => {
  it("another element takes the pointer → intercepted, also when it was not visible before", () => {
    const tail =
      "\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n      - element is not visible\n    - retrying click action\n" +
      '\u001b[2m      - element is visible, enabled and stable\u001b[22m\n\u001b[2m      - <div id="backdrop">…</div> intercepts pointer events\u001b[22m\n    - retrying click action\n';
    expect(clickFailure(log(tail))).toBe("intercepted");
  });

  it("not visible, not enabled, detached", () => {
    expect(clickFailure(log("    2 × waiting for element to be visible, enabled and stable\n      - element is not visible\n"))).toBe("not-visible");
    expect(clickFailure(log("    2 × waiting for element to be visible, enabled and stable\n      - element is not enabled\n"))).toBe("not-enabled");
    expect(clickFailure(log("    - element was detached from the DOM, retrying\n"))).toBe("detached");
    // The element observed a moment ago matches nothing any more: it is gone from the page.
    expect(clickFailure("locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save', exact: true }).first()\n")).toBe("detached");
  });

  it("found, but no reason before the limit → timeout; an error that is no click timeout → no cause", () => {
    expect(clickFailure(log("    - waiting for element to be visible, enabled and stable\n"))).toBe("timeout");
    expect(clickFailure("locator.click: Target page, context or browser has been closed")).toBeUndefined();
  });
});

describe("recordedPath — a request as the run keeps it (#224)", () => {
  it("keeps the path and plain query values, redacts token-like ones and secret-named ones", () => {
    expect(recordedPath("http://app.test/api/save?token=abc123XYZ789&page=2&sort=name")).toBe("/api/save?token=‹redacted›&page=2&sort=name");
    expect(recordedPath("http://app.test/login?user=jdoe&password=qwerty")).toBe("/login?user=jdoe&password=‹redacted›");
    expect(recordedPath("http://app.test/search?q=order%20A1B2C3D4%20late")).toBe("/search?q=order ‹redacted› late");
    expect(recordedPath("http://app.test/api/orders")).toBe("/api/orders");
  });
});
