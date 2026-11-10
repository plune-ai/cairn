import { describe, it, expect } from "vitest";
import { clickEffect, clickFailure, recordedPath, recordedUrl } from "../../src/browser/click-effect.js";

/** A page's ARIA snapshot, before or after a click. */
const page = (...lines: string[]): string => ["- main:", '  - heading "Orders" [level=1]', ...lines].join("\n");
/** What the page itself saw after the click: nothing, unless a test says otherwise. */
const quiet = { state: [], mutated: false, appeared: [] };
const base = { page: "http://app.test/orders", url: "http://app.test/orders", role: "button", name: "Save", requests: [], seen: quiet };
/** The DOM changed: the ARIA snapshot is read again and compared with the one before. */
const changed = (before: string, after: string) => ({ ...base, seen: { ...quiet, mutated: true }, before, after });

describe("clickEffect — what a click changed, as one name from a closed set (#224)", () => {
  it("a new URL → navigated; the next page is not diffed against this one", () => {
    const e = clickEffect({ ...changed(page(), page("  - text: other page")), url: "http://app.test/orders/7" });
    expect(e.outcome).toBe("navigated");
    expect(e.url).toBe("http://app.test/orders/7");
    expect(e.added).toEqual([]);
  });

  it("a new tab → opened-tab, a file → downloaded", () => {
    expect(clickEffect({ ...base, tab: "http://app.test/help" }).outcome).toBe("opened-tab");
    expect(clickEffect({ ...base, download: "report.csv" }).outcome).toBe("downloaded");
  });

  it("a dialog that appears → overlay-opened, a menu that goes away → overlay-closed", () => {
    const opened = clickEffect(changed(page(), page('  - dialog "Edit order":', '    - button "Close"')));
    expect(opened.outcome).toBe("overlay-opened");
    expect(opened.opened).toEqual(['dialog "Edit order"']);
    const closed = clickEffect(changed(page('  - menu "Actions":', '    - menuitem "Copy"'), page()));
    expect(closed.outcome).toBe("overlay-closed");
    expect(closed.closed).toEqual(['menu "Actions"']);
    // A menuitem or a menubar is not an overlay of its own.
    expect(clickEffect(changed(page(), page('  - menubar "Main"'))).opened).toEqual([]);
  });

  it("the element's own state, the focus or the scroll that moved → state-changed", () => {
    for (const s of [
      { attr: "checked" as const, before: "false", after: "true" },
      { attr: "focus" as const, before: "body", after: "Search" },
      { attr: "scroll" as const, before: "0,2400", after: "0,0" },
    ]) {
      const e = clickEffect({ ...base, seen: { ...quiet, state: [s] } });
      expect(e.outcome).toBe("state-changed");
      expect(e.state).toEqual([s]);
    }
  });

  it("other ARIA lines that changed → content-changed; so does text that appeared and went again (a toast)", () => {
    const e = clickEffect(changed(page('  - status: ""'), page("  - status: Saved")));
    expect(e.outcome).toBe("content-changed");
    expect(e.added).toEqual(["- status: Saved"]);
    expect(e.removed).toEqual(['- status: ""']);
    const toast = clickEffect({ ...changed(page(), page()), seen: { ...quiet, mutated: true, appeared: ["Saved!"] } });
    expect(toast.outcome).toBe("content-changed");
    expect(toast.appeared).toEqual(["Saved!"]);
  });

  it("a DOM change that shows nothing (a class, a style) is no effect", () => {
    expect(clickEffect(changed(page(), page())).outcome).toBe("no-effect");
  });

  it("nothing visible, but a request answered 2xx → network-only (a silent save is an effect)", () => {
    const e = clickEffect({ ...base, requests: [{ method: "POST", path: "/api/orders", status: 201 }] });
    expect(e.outcome).toBe("network-only");
  });

  it("nothing changed at all → no-effect; a failed or unanswered request is not an effect either", () => {
    expect(clickEffect(base).outcome).toBe("no-effect");
    const requests = [{ method: "POST", path: "/api/orders", status: 500 }, { method: "GET", path: "/api/slow" }];
    expect(clickEffect({ ...base, requests }).outcome).toBe("no-effect");
  });

  it("what could not be read is unknown, never no-effect: no page watch, no snapshot after a change, a navigation on its way", () => {
    expect(clickEffect({ ...base, seen: undefined }).outcome).toBe("unknown");
    expect(clickEffect({ ...changed(page(), page()), after: undefined }).outcome).toBe("unknown");
    expect(clickEffect({ ...changed(page(), page()), before: undefined }).outcome).toBe("unknown");
    expect(clickEffect({ ...base, navigating: true }).outcome).toBe("unknown");
  });

  it("#252: a request the write guard stopped: what its answer would have done is not known, so it is no dead click", () => {
    expect(clickEffect({ ...base, stopped: true }).outcome).toBe("unknown");
    // what was seen still names the click
    expect(clickEffect({ ...changed(page(), page('  - dialog "Edit order":')), stopped: true }).outcome).toBe("overlay-opened");
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

  it("not visible, not enabled, detached (found, then gone)", () => {
    expect(clickFailure(log("    2 × waiting for element to be visible, enabled and stable\n      - element is not visible\n"))).toBe("not-visible");
    expect(clickFailure(log("    2 × waiting for element to be visible, enabled and stable\n      - element is not enabled\n"))).toBe("not-enabled");
    expect(clickFailure(log("    - element was detached from the DOM, retrying\n"))).toBe("detached");
  });

  it("the locator matched nothing → not-found (the backend then asks whether a hidden one matches)", () => {
    expect(clickFailure("locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save', exact: true }).first()\n")).toBe("not-found");
  });

  it("found, but no reason before the limit → timeout; an error that is no click timeout → no cause", () => {
    expect(clickFailure(log("    - waiting for element to be visible, enabled and stable\n"))).toBe("timeout");
    expect(clickFailure("locator.click: Target page, context or browser has been closed")).toBeUndefined();
  });
});

describe("recordedPath / recordedUrl — no secret leaves in a recorded URL (#224)", () => {
  // 26 URL forms that leaked a value once: each is written without its query values, every credential-shaped part replaced.
  it.each([
    ["http://app.test/reset/9f86d081884c7d659a2feaa0c55ad015", "/reset/‹v›"],
    ["http://app.test/invite/accept/QwErTyUiOpAsDfGh", "/invite/accept/‹v›"],
    ["http://app.test/app/orders;jsessionid=1A2B3C4D5E6F7A8B", "/app/orders"],
    ["http://app.test/cb#access_token=abc123XYZ789", "/cb"],
    ["http://jdoe:Sup3rS3cret@app.test/api/x", "/api/x"],
    ["http://app.test/api?t=abc123%3D%3D", "/api?t=‹v›"],
    ["http://app.test/api?t=AbCdEfGh+IjKlMnOp", "/api?t=‹v›"],
    ["http://app.test/verify?code=482913", "/verify?code=‹v›"],
    ["http://app.test/cb?code=SplxlOBeZQQYbYS6WxSbIA&state=xyz", "/cb?code=‹v›&state=‹v›"],
    ["http://app.test/cb?code=SplxlOBeZQQYbYSWxSbIA", "/cb?code=‹v›"],
    ["http://app.test/cb?state=kQpZrTnVbWmXyLsD", "/cb?state=‹v›"],
    ["http://app.test/dl?sig=a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", "/dl?sig=‹v›"],
    ["http://app.test/api?token=abcdefghijklmnopqrst", "/api?token=‹v›"],
    ["http://app.test/api?access_token=abcdefghijklmnopqrst", "/api?access_token=‹v›"],
    ["http://app.test/api?api_key=QwErTyUiOpAsDfGhJk", "/api?api_key=‹v›"],
    ["http://app.test/login?password=qwerty", "/login?password=‹v›"],
    ["http://app.test/verify?otp=482913", "/verify?otp=‹v›"],
    ["http://app.test/verify?pin=4711", "/verify?pin=‹v›"],
    ["http://app.test/api?sessionid=8812736451928374", "/api?sessionid=‹v›"],
    ["http://app.test/api?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "/api?jwt=‹v›"],
    ["http://app.test/magic/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "/magic/‹v›"],
    [
      "http://app.test/f?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261104%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024",
      "/f?X-Amz-Credential=‹v›&X-Amz-Signature=‹v›",
    ],
    ["http://app.test/api?email=john.doe%40example.com", "/api?email=‹v›"],
    ["http://app.test/api?sk_live_51HxYzAbC=1", "/api?‹v›=‹v›"],
    ["http://app.test/api?q=a%26b%3Dc", "/api?q=‹v›"],
    ["http://app.test/api/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301", "/api/orders/‹v›"],
  ])("%s → %s", (url, path) => {
    expect(recordedPath(url)).toBe(path);
  });

  it("keeps what names an endpoint: words, short ids, slugs, a version", () => {
    expect(recordedPath("http://app.test/api/v2/orders/42/line-items/my-first-order")).toBe("/api/v2/orders/42/line-items/my-first-order");
  });

  it("a page URL keeps its origin, never its user, password or fragment", () => {
    expect(recordedUrl("http://jdoe:Sup3rS3cret@app.test/cb?code=482913#access_token=abc123XYZ789")).toBe("http://app.test/cb?code=‹v›");
  });
});
