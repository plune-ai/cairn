import { describe, it, expect } from "vitest";
import { globalKeyAction, stepBack } from "../../../src/tui/keys.js";

describe("globalKeyAction", () => {
  it("Escape always backs out — even while a text field owns the keyboard", () => {
    expect(globalKeyAction("", { escape: true }, { inTextField: true })).toEqual({ type: "back" });
  });

  it("Escape backs out on a non-text step too", () => {
    expect(globalKeyAction("", { escape: true }, { inTextField: false })).toEqual({ type: "back" });
  });

  it('"q" quits when no text field owns the keyboard', () => {
    expect(globalKeyAction("q", {}, { inTextField: false })).toEqual({ type: "quit" });
  });

  it('"q" is NOT a quit while a text field is focused (it is a printable char there)', () => {
    expect(globalKeyAction("q", {}, { inTextField: true })).toBeNull();
  });

  it("an ordinary character on a non-text step is ignored", () => {
    expect(globalKeyAction("a", {}, { inTextField: false })).toBeNull();
  });

  it("an ordinary character in a text field is ignored (the field handles it)", () => {
    expect(globalKeyAction("a", {}, { inTextField: true })).toBeNull();
  });

  it("Escape takes priority over a coincident printable input", () => {
    // esc is reported with input "" by Ink, but guard against any input leaking through.
    expect(globalKeyAction("q", { escape: true }, { inTextField: false })).toEqual({ type: "back" });
  });
});

describe("stepBack", () => {
  it("does not consume at step 0 (caller pops the screen instead)", () => {
    expect(stepBack(0)).toEqual({ stepIndex: 0, consumed: false });
  });

  it("steps back and consumes from step 1", () => {
    expect(stepBack(1)).toEqual({ stepIndex: 0, consumed: true });
  });

  it("steps back and consumes from a later step", () => {
    expect(stepBack(3)).toEqual({ stepIndex: 2, consumed: true });
  });
});
