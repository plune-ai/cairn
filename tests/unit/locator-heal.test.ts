import { describe, it, expect } from "vitest";
import { parseBrokenLocator, compatibleRoles, healCandidates, locatorText } from "../../src/decider/uses/locator-heal.js";

describe("parseBrokenLocator (spec §6.6)", () => {
  it.each([
    [
      "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Sign' })",
      { role: "button", name: "Sign", source: "getByRole('button', { name: 'Sign' })" },
    ],
    [
      'Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole("link", { name: "Profile", exact: true })\nExpected: visible',
      { role: "link", name: "Profile", source: 'getByRole("link", { name: "Profile", exact: true })' },
    ],
    [
      "Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Зберегти' }) resolved to 2 elements:",
      { role: "button", name: "Зберегти", source: "getByRole('button', { name: 'Зберегти' })" },
    ],
    [
      "Error: locator.fill: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('textbox')",
      { role: "textbox", source: "getByRole('textbox')" },
    ],
    [
      "Call log:\n  - waiting for getByRole('button', { name: 'Don\\'t save' })",
      { role: "button", name: "Don't save", source: "getByRole('button', { name: 'Don\\'t save' })" },
    ],
    [
      // Playwright colours its output; the codes are not part of the locator.
      "Call log:\n  \u001b[2m- waiting for getByRole('button', { name: 'Sign' })\u001b[22m",
      { role: "button", name: "Sign", source: "getByRole('button', { name: 'Sign' })" },
    ],
    [
      // a trailing .first() is outside the broken part: the replacement keeps it
      "Call log:\n  - waiting for getByRole('link', { name: 'Docs' }).first()",
      { role: "link", name: "Docs", source: "getByRole('link', { name: 'Docs' })" },
    ],
  ])("%j", (error, expected) => {
    expect(parseBrokenLocator(error)).toEqual(expected);
  });

  it.each([
    ["no locator at all", "Error: page.goto: net::ERR_CONNECTION_REFUSED"],
    ["a CSS locator", "Call log:\n  - waiting for locator('#submit')"],
    ["another getBy", "Call log:\n  - waiting for getByText('Save')"],
    ["a regex name — nothing exact to heal from", "Call log:\n  - waiting for getByRole('button', { name: /Sign/i })"],
    // A scoped locator: a page-wide candidate may sit outside the scope, and verify() checks the whole page.
    ["a chain into a scope", "Call log:\n  - waiting for getByRole('dialog').getByRole('button', { name: 'OK' })"],
    ["a chain from a scope", "Call log:\n  - waiting for locator('form').getByRole('button', { name: 'OK' })"],
    // a colour code between the links must not hide the chain
    ["a chain split by a colour code", "Call log:\n  - waiting for getByRole('dialog')\u001b[22m.getByRole('button', { name: 'OK' })"],
  ])("%s → nothing to heal", (_label, error) => {
    expect(parseBrokenLocator(error)).toBeUndefined();
  });
});

describe("compatibleRoles", () => {
  it.each([
    ["button", ["button"]],
    ["link", ["link"]],
    ["textbox", ["combobox", "searchbox", "textbox"]],
    ["searchbox", ["combobox", "searchbox", "textbox"]],
    ["combobox", ["combobox", "searchbox", "textbox"]],
    ["checkbox", ["checkbox", "switch"]],
    ["switch", ["checkbox", "switch"]],
    ["menuitem", ["menuitem", "menuitemcheckbox", "menuitemradio"]],
    ["menuitemradio", ["menuitem", "menuitemcheckbox", "menuitemradio"]],
  ])("%s → %j", (role, expected) => {
    expect([...compatibleRoles(role)].sort()).toEqual(expected);
  });
});

describe("healCandidates", () => {
  const aria = [
    "- banner:",
    '  - link "Home"',
    '  - button "Log out"',
    "- main:",
    '  - heading "Sign in" [level=1]',
    '  - textbox "Email"',
    '  - button "Sign in"',
    '  - button "Save"',
    '  - button "Save"',
    '  - link "Save"',
    '  - button "Delete account"',
    '  - button "Clear form"',
    "  - button",
    '  - checkbox "Remember me"',
  ].join("\n");

  it("ASYMMETRY: a destructive element and an incompatible role are never candidates", () => {
    const got = healCandidates(aria, { role: "button", name: "Sav", source: "getByRole('button', { name: 'Sav' })" });
    expect(got.map((e) => `${e.role} ${e.name}`)).toEqual(["button Sign in", "button Save"]);
  });

  it("compatible roles count: a switch may replace a checkbox", () => {
    const got = healCandidates(`${aria}\n- switch "Dark mode"`, { role: "checkbox", source: "getByRole('checkbox')" });
    expect(got.map((e) => `${e.role} ${e.name}`)).toEqual(["checkbox Remember me", "switch Dark mode"]);
  });

  it("only interactive elements are healed: a heading assertion keeps today's repair", () => {
    expect(healCandidates(aria, { role: "heading", name: "Sign", source: "getByRole('heading', { name: 'Sign' })" })).toEqual([]);
  });

  it("an empty snapshot has no candidates", () => {
    expect(healCandidates("", { role: "button", source: "getByRole('button')" })).toEqual([]);
  });
});

describe("locatorText", () => {
  it.each([
    [{ role: "button", name: "Save" }, "getByRole('button', { name: 'Save', exact: true })"],
    [{ role: "button", name: "Don't save" }, "getByRole('button', { name: 'Don\\'t save', exact: true })"],
    [{ role: "link", name: "C:\\docs" }, "getByRole('link', { name: 'C:\\\\docs', exact: true })"],
  ])("%j → %s", (el, expected) => {
    expect(locatorText(el)).toBe(expected);
  });

  it("round-trips through parseBrokenLocator", () => {
    const text = locatorText({ role: "button", name: "Don't save" });
    expect(parseBrokenLocator(`waiting for ${text}`)).toMatchObject({ role: "button", name: "Don't save", source: text });
  });
});
