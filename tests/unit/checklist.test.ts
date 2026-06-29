import { describe, it, expect } from "vitest";
import {
  ingestChecklist,
  formatChecklist,
  formatGoal,
  coverageScore,
  detectLanguage,
  styleDirective,
} from "../../src/checklist/index.js";

describe("checklist", () => {
  it("ingest: bullets/numbering → items; headings and blanks are skipped", () => {
    const items = ingestChecklist("# Логін\n- Перевірити кнопку Login\n* Поле email\n\n1. Вийти з системи\n");
    expect(items.map((i) => i.text)).toEqual([
      "Перевірити кнопку Login",
      "Поле email",
      "Вийти з системи",
    ]);
  });

  it("ingest: structured doc (## headings) → case headings as items", () => {
    const items = ingestChecklist("# Доковий заголовок\n## TC-01. Логін\n**Кроки:**\n1. крок\n## TC-02. Вихід\n");
    expect(items.map((i) => i.text)).toEqual(["TC-01. Логін", "TC-02. Вихід"]);
  });

  it("formatChecklist: empty → '', otherwise a block with the items", () => {
    expect(formatChecklist([])).toBe("");
    expect(formatChecklist([{ text: "A" }])).toContain("A");
  });

  it("coverageScore: fraction of items mentioned in the cases (by tokens)", () => {
    const items = ingestChecklist("- Login button\n- Logout flow");
    const cases = [{ title: "Verify Login button visible", steps: [] as string[], expected: "" }];
    expect(coverageScore(items, cases)).toBe(0.5); // login covered, logout not
  });

  it("coverageScore: empty checklist → 0", () => {
    expect(coverageScore([], [{ title: "x", steps: [], expected: "" }])).toBe(0);
  });

  it("detectLanguage: Cyrillic → Ukrainian, Latin → English", () => {
    expect(detectLanguage("Перемикання вкладок")).toBe("Ukrainian");
    expect(detectLanguage("Switch between tabs")).toBe("English");
  });

  it("formatGoal: blank/undefined → '', otherwise a directive carrying the goal (#63)", () => {
    expect(formatGoal()).toBe("");
    expect(formatGoal("")).toBe("");
    expect(formatGoal("   ")).toBe(""); // whitespace-only is no goal
    const d = formatGoal("  test the checkout flow  ");
    expect(d).toContain("test the checkout flow"); // trimmed, embedded
    expect(d).toContain("GOAL FOR THIS RUN");
  });

  it("styleDirective: happy/negative/coverage → a directive; all/'' → ''", () => {
    expect(styleDirective("negative")).toContain("NEGATIVE");
    expect(styleDirective("coverage")).toContain("GAPS");
    expect(styleDirective("happy")).toContain("POSITIVE");
    expect(styleDirective("all")).toBe("");
    expect(styleDirective("")).toBe("");
  });
});
