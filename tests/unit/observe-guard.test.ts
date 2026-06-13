import { describe, it, expect } from "vitest";
import { findConsentDismiss, describeObserveError } from "../../src/agent/observe-guard.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";

describe("findConsentDismiss (L1-04, Box 1 — cookie/consent walls)", () => {
  it("prefers a decline/reject control over accept (privacy-preserving default)", () => {
    const els = parseAriaSnapshot('- button "Accept all"\n- button "Reject all"\n- button "Sign in"');
    expect(findConsentDismiss(els)?.name).toBe("Reject all");
  });

  it("recognizes an 'Only necessary' style control", () => {
    const els = parseAriaSnapshot('- button "Accept all cookies"\n- button "Only necessary"');
    expect(findConsentDismiss(els)?.name).toMatch(/only necessary/i);
  });

  it("falls back to an explicit accept to clear a hard wall when nothing else exists", () => {
    const els = parseAriaSnapshot('- button "Accept all cookies"\n- link "Privacy policy"');
    expect(findConsentDismiss(els)?.name).toMatch(/accept/i);
  });

  it("returns undefined when there is no consent wall", () => {
    const els = parseAriaSnapshot('- button "Sign in"\n- textbox "Email"');
    expect(findConsentDismiss(els)).toBeUndefined();
  });

  it("ignores non-interactive look-alikes (e.g. a heading that says 'Accept cookies')", () => {
    const els = parseAriaSnapshot('- heading "Accept cookies to continue"\n- button "Sign in"');
    expect(findConsentDismiss(els)).toBeUndefined();
  });
});

describe("describeObserveError (L1-04, Box 1 — readable, no stack trace)", () => {
  it("classifies a navigation timeout", () => {
    const msg = describeObserveError(new Error("page.goto: Timeout 30000ms exceeded"), "https://app.test/x");
    expect(msg.toLowerCase()).toMatch(/timed out|could not load/);
    expect(msg).toContain("https://app.test/x");
  });

  it("classifies an unreachable host (DNS / connection refused)", () => {
    const msg = describeObserveError(new Error("net::ERR_NAME_NOT_RESOLVED at https://nope.invalid"), "https://nope.invalid");
    expect(msg.toLowerCase()).toMatch(/reach|connection|navigation|dns/);
    expect(msg).toContain("https://nope.invalid");
  });

  it("never leaks a multi-line stack trace", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at foo (file.ts:1:1)\n    at bar (file.ts:2:2)";
    const msg = describeObserveError(err, "https://app.test");
    expect(msg).not.toMatch(/\n\s+at /);
    expect(msg.split("\n").length).toBe(1);
  });
});
