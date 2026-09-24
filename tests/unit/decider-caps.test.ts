import { describe, it, expect } from "vitest";
import { CAPS, checkCaps, questionChars } from "../../src/decider/capabilities.js";
import { DeciderUnavailable, type Question } from "../../src/decider/types.js";

const yesNo: Question = { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } };

describe("checkCaps — refuse what a provider cannot answer faithfully, before any request", () => {
  it("questionChars counts the instructions and every option's label and description", () => {
    expect(questionChars(yesNo)).toBe(11);
    expect(questionChars({ type: "choice", instructions: "pick", options: { ab: "desc", c: null } })).toBe(4 + 2 + 4 + 1);
    expect(questionChars({ type: "score", instructions: "rate", levels: ["low", "high"] })).toBe(4 + 3 + 4);
  });

  it("laya: the state plus its longest question over 1200 chars is refused (laya would truncate silently)", () => {
    expect(() => checkCaps(CAPS.laya, "x".repeat(1200 - 11), { q: yesNo })).not.toThrow();
    expect(() => checkCaps(CAPS.laya, "x".repeat(1201 - 11), { q: yesNo })).toThrow(
      "input is 1201 chars (state 1190 + question 11) > 1200",
    );
  });

  it("a long question leaves less room for the state", () => {
    const long: Question = { type: "noul", instructions: "i".repeat(300), criteria: { true: "yes", false: "no" } };
    expect(() => checkCaps(CAPS.laya, "x".repeat(900), { a: yesNo, b: long })).toThrow(/state 900 \+ question 305/);
  });

  it("laya: a question over 400 chars is refused on its own (laya cuts the question part at 192 tokens)", () => {
    const q: Question = { type: "choice", instructions: "pick", options: { a: "x".repeat(200), b: "y".repeat(200) } };
    expect(() => checkCaps(CAPS.laya, "s", { q })).toThrow("question 'q' is 406 chars > 400");
    expect(() => checkCaps(CAPS.jev, "s", { q })).not.toThrow();
  });

  it("laya: one option over 100 chars is refused even inside a short question (laya cuts each option at 48 tokens)", () => {
    const at = (n: number): Question => ({ type: "noul", instructions: "Is it?", criteria: { true: "t".repeat(n), false: "no" } });
    expect(() => checkCaps(CAPS.laya, "s", { q: at(100) })).not.toThrow();
    expect(() => checkCaps(CAPS.laya, "s", { q: at(101) })).toThrow("question 'q': an option is 101 chars > 100");
    expect(() => checkCaps(CAPS.compat, "s", { q: at(101) })).toThrow(DeciderUnavailable);
    expect(() => checkCaps(CAPS.jev, "s", { q: at(370) })).not.toThrow();
    // A choice option counts as laya renders it — "label: description"; a score level on its own.
    const choice: Question = { type: "choice", instructions: "pick", options: { label: "d".repeat(94), other: null } };
    expect(() => checkCaps(CAPS.laya, "s", { q: choice })).toThrow("an option is 101 chars > 100");
    const score: Question = { type: "score", instructions: "rate", levels: ["low", "h".repeat(101)] };
    expect(() => checkCaps(CAPS.laya, "s", { q: score })).toThrow("an option is 101 chars > 100");
  });

  it("jev: 60k chars of input pass, more is refused", () => {
    expect(() => checkCaps(CAPS.jev, "x".repeat(60_000 - 11), { q: yesNo })).not.toThrow();
    expect(() => checkCaps(CAPS.jev, "x".repeat(60_001 - 11), { q: yesNo })).toThrow(DeciderUnavailable);
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
    expect(CAPS.compat).toMatchObject({
      maxInputChars: 1200,
      maxQuestionChars: 400,
      maxOptionChars: 100,
      maxOptions: 20,
      maxQuestionsPerCall: 16,
    });
    expect(CAPS.compat.price).toBeUndefined();
    expect(CAPS.laya.price).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(CAPS.jev.price).toEqual({ inputPer1M: 0.042, outputPer1M: 0 });
  });
});
