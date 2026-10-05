import { describe, it, expect } from "vitest";
import { checkProvenance, guardDeletion, isDeletionIntent } from "../../src/safety/guardrails.js";
import type { PilotVerdict } from "../../src/eval/pilot.js";

const pass = (entity: string, reason = "looks good"): PilotVerdict => ({
  verdict: "pass",
  reason,
  guidance: "ship it",
  entity,
});

describe("checkProvenance (#91 — provenance-checked Pilot verdict)", () => {
  it("keeps a pass when the named entity appears in the session log", () => {
    const v = checkProvenance(pass("Invoice #42"), ["created Invoice #42", "filled amount"]);
    expect(v.verdict).toBe("pass");
  });

  it("REJECTS a pass when the entity is absent from the log → needs-work with a reason", () => {
    const v = checkProvenance(pass("Ghost Item"), ["clicked Save", "navigated to /items"]);
    expect(v.verdict).toBe("needs-work");
    expect(v.reason).toMatch(/provenance/i);
    expect(v.reason).toContain("Ghost Item");
  });

  it("passes a read-only run through (no entity claimed)", () => {
    const v = checkProvenance(pass(""), []); // nothing created → nothing to prove
    expect(v.verdict).toBe("pass");
  });

  it("never upgrades — a non-pass verdict is returned untouched", () => {
    const nw: PilotVerdict = { verdict: "needs-work", reason: "gaps", guidance: "more cases", entity: "X" };
    expect(checkProvenance(nw, [])).toEqual(nw);
  });

  it("matches the entity case-insensitively", () => {
    expect(checkProvenance(pass("WIDGET"), ["created a widget"]).verdict).toBe("pass");
  });
});

describe("guardDeletion (#91 — data-protection guardrail)", () => {
  it("ALLOWS deleting a self-created item (disposable)", () => {
    const r = guardDeletion("temp-item-1", { selfCreated: ["temp-item-1"] });
    expect(r.allowed).toBe(true);
  });

  it("BLOCKS deleting pre-existing data, with a clear reason", () => {
    const r = guardDeletion("Customer Acme", { selfCreated: ["temp-item-1"] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/pre-existing/i);
    expect(r.reason).toContain("Customer Acme");
  });

  it("BLOCKS deleting the resource under the current URL", () => {
    const r = guardDeletion("https://app/items/1", { currentUrl: "https://app/items/1/", selfCreated: ["https://app/items/1"] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/current URL/i);
  });

  it("BLOCKS an empty target", () => {
    expect(guardDeletion("   ").allowed).toBe(false);
  });

  it("matches self-created entries case/trailing-slash insensitively", () => {
    expect(guardDeletion("Temp-Item-1", { selfCreated: ["temp-item-1 "] }).allowed).toBe(true);
  });
});

describe("isDeletionIntent (#91 — gate for stateful setup steps)", () => {
  it("flags delete/clear/reset intents", () => {
    for (const t of ["delete all existing items", "clear the list", "reset the account", "purge old records", "clean up data"]) {
      expect(isDeletionIntent(t), t).toBe(true);
    }
  });

  it("does not flag read/create intents", () => {
    for (const t of ["log in as admin", "an existing item is in the list", "create a new invoice"]) {
      expect(isDeletionIntent(t), t).toBe(false);
    }
  });

  it("English: a participle is not an intent — only the base form counts", () => {
    for (const t of ["Deleted items", "the list was cleared", "a removed user"]) {
      expect(isDeletionIntent(t), t).toBe(false);
    }
  });
});

// #185 — the same filter, in Ukrainian and Russian. `\b` never fires next to Cyrillic, even with the `u` flag (`\w` stays
// ASCII), so these words are delimited by `\p{L}` lookarounds. A word counts in the forms a button or a step uses — the
// infinitive, the imperative, and the noun where it is itself the label (Скидання, Сброс) — and never as a participle
// or an adjective of the same root. That is also what the English filter does: "Delete" counts, "Deleted items" does not.
describe("isDeletionIntent — Ukrainian and Russian (#185)", () => {
  it("flags Ukrainian deletion intents", () => {
    for (const t of [
      "Видалити акаунт",
      "Видалити всі наявні елементи, щоб список був порожнім",
      "Видаліть усі записи користувача",
      "Вилучити користувача зі списку",
      "Очистити кошик",
      "Очистіть форму",
      "Скинути пароль",
      "Скидання налаштувань",
      "ОЧИСТИТИ КЕШ",
    ]) {
      expect(isDeletionIntent(t), t).toBe(true);
    }
  });

  it("flags Russian deletion intents", () => {
    for (const t of [
      "Удалить аккаунт",
      "Удалить все существующие записи",
      "Удалите все записи пользователя",
      "Очистить корзину",
      "Очистите форму",
      "Сбросить пароль",
      "Сброс настроек",
      "ОЧИСТИТЬ КЭШ",
    ]) {
      expect(isDeletionIntent(t), t).toBe(true);
    }
  });

  // Every form the pattern lists, bare: take one alternative out of the pattern and its row goes red. «очисти» is the
  // same form in both languages, so it stands once.
  it.each([
    // Ukrainian: delete, remove, clear, reset
    "видалити",
    "видаляти",
    "видали",
    "видаліть",
    "вилучити",
    "вилучати",
    "вилучи",
    "вилучіть",
    "очистити",
    "очисти",
    "очистіть",
    "очищати",
    "очищувати",
    "скинути",
    "скинь",
    "скиньте",
    "скидати",
    "скидання",
    // Russian: delete, clear, reset
    "удалить",
    "удалять",
    "удали",
    "удалите",
    "очистить",
    "очистите",
    "очищать",
    "сброс",
    "сбросить",
    "сбрось",
    "сбросьте",
    "сбрасывать",
  ])("every listed form is flagged: %s", (form) => {
    expect(isDeletionIntent(form), form).toBe(true);
  });

  it.each([
    ["Видалені елементи", "the Deleted items folder: a state, not the action"],
    ["Видалений користувач", "the name a deleted user is shown under"],
    ["Політика видалення даних", "a noun: the policy page, not the action"],
    ["Очищена вода", "purified water, an adjective"],
    ["Очисні споруди", "sewage treatment plants"],
    ["Користувач увійшов у систему", "no deletion at all"],
    ["Удалённый доступ", "Remote access — «удалённый» is not «удалить»"],
    ["Удалённая работа", "remote jobs"],
    ["Удалённые", "the Deleted items folder: a state, not the action"],
    ["Очищенная вода", "purified water, an adjective"],
    ["Очистные сооружения", "sewage treatment plants"],
    ["Пользователь вошёл в систему", "no deletion at all"],
    // The word boundaries: a listed form that only begins, ends or sits inside another word is not that word.
    ["Видалили", "past tense: only begins like the imperative «видали»"],
    ["Удалили", "past tense: only begins like the imperative «удали»"],
    ["Очистили", "past tense: only begins like the imperative «очисти»"],
    ["Сброса", "a case form of the noun: only the nominative «сброс» counts"],
    ["Видалити_все", "an underscore after it continues the word"],
    ["Скинути2", "a digit after it continues the word"],
    ["Перескинути", "a letter before it: another word, not «скинути»"],
    ["2Скинути", "a digit before it continues the word"],
    ["_Видалити", "an underscore before it continues the word"],
  ])("a benign name that shares a root with a deletion verb is not flagged: %s (%s)", (text) => {
    expect(isDeletionIntent(text), text).toBe(false);
  });

  it("an ambiguous word is refused on purpose: a refusal costs a manual precondition, a miss costs the user's data", () => {
    // "Lose weight" shares its word with a reset: nothing in «скинути» or «сброс» tells the two apart.
    for (const t of ["Скинути вагу", "Сброс веса"]) {
      expect(isDeletionIntent(t), t).toBe(true);
    }
  });
});
