import { describe, it, expect } from "vitest";
import { CAPS, checkCaps } from "../../src/decider/capabilities.js";
import { DeciderUnavailable, type Question } from "../../src/decider/types.js";

const yesNo: Question = { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } };

describe("checkCaps — refuse what a provider cannot answer faithfully, before any request", () => {
  it("laya: a state over 1200 chars is refused (laya would truncate it silently)", () => {
    expect(() => checkCaps(CAPS.laya, "x".repeat(1201), { q: yesNo })).toThrow(DeciderUnavailable);
    expect(() => checkCaps(CAPS.laya, "x".repeat(1200), { q: yesNo })).not.toThrow();
  });

  it("jev: 60k chars pass, more is refused", () => {
    expect(() => checkCaps(CAPS.jev, "x".repeat(60_000), { q: yesNo })).not.toThrow();
    expect(() => checkCaps(CAPS.jev, "x".repeat(60_001), { q: yesNo })).toThrow(DeciderUnavailable);
  });

  it("a choice with more options than the provider takes is refused", () => {
    const options = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, null]));
    const q: Question = { type: "choice", instructions: "pick", options };
    expect(() => checkCaps(CAPS.laya, "s", { q })).toThrow(/options/);
    expect(() => checkCaps(CAPS.jev, "s", { q })).not.toThrow();
  });

  it("a choice needs at least two options; a score 2..10 levels", () => {
    expect(() => checkCaps(CAPS.jev, "s", { q: { type: "choice", instructions: "pick", options: { only: null } } })).toThrow(
      DeciderUnavailable,
    );
    expect(() => checkCaps(CAPS.jev, "s", { q: { type: "score", instructions: "rate", levels: ["low"] } })).toThrow(
      DeciderUnavailable,
    );
    expect(() =>
      checkCaps(CAPS.jev, "s", { q: { type: "score", instructions: "rate", levels: Array<string>(11).fill("l") } }),
    ).toThrow(DeciderUnavailable);
    expect(() =>
      checkCaps(CAPS.jev, "s", { q: { type: "score", instructions: "rate", levels: ["low", "high"] } }),
    ).not.toThrow();
  });

  it("too many questions per call, or none, is refused", () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, yesNo]));
    expect(() => checkCaps(CAPS.laya, "s", many)).toThrow(/questions/);
    expect(() => checkCaps(CAPS.laya, "s", {})).toThrow(/no questions/);
  });

  it("compat gets laya's conservative caps (unknown server) and no price", () => {
    expect(CAPS.compat).toMatchObject({ maxStateChars: 1200, maxOptions: 20, maxQuestionsPerCall: 16 });
    expect(CAPS.compat.price).toBeUndefined();
    expect(CAPS.laya.price).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(CAPS.jev.price).toEqual({ inputPer1M: 0.042, outputPer1M: 0 });
  });
});
