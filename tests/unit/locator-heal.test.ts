import { describe, it, expect, vi } from "vitest";
import {
  parseBrokenLocator,
  compatibleRoles,
  healCandidates,
  locatorText,
  makeHeal,
  lazyGateway,
} from "../../src/decider/uses/locator-heal.js";
import { CAPS, checkCaps } from "../../src/decider/capabilities.js";
import { DeciderUnavailable, type Answer, type Decider, type Question, type ShadowEntry } from "../../src/decider/types.js";
import type { TriageResult } from "../../src/decider/uses/repair-triage.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";
import type { ElementRef } from "../../src/browser/types.js";
import type { TestResult } from "../../src/validate/index.js";

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

// ── the healer (Task 15) ────────────────────────────────────────────────────────────────────────────────────────

const PAGE = [
  '- button "Log out"',
  '- textbox "Email"',
  '- button "Sign in"',
  '- button "Create account"',
  '- link "Sign in with Google"',
  '- button "Delete account"',
].join("\n");
const BROKEN = "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Sign' })";
const failure = (error = BROKEN, test = "tc-1: signs in"): TestResult => ({ test, status: "failed", error });
const triage = (category: TriageResult["category"] = "locator-missing"): TriageResult => ({
  test: "tc-1: signs in",
  category,
  confidence: 0.9,
  exclude: false,
});
const pick = (value: string, confidence = 0.9): Answer => ({ type: "choice", value, dist: { [value]: confidence }, confidence });
const optionFor = (q: Question, text: string): string =>
  Object.entries(q.type === "choice" ? q.options : {}).find(([, d]) => d?.includes(text))?.[0] ?? "c-missing";

/** A decider whose answers are scripted per question; each call is checked against the provider's real caps. */
function healDecider(
  answer: (q: Question) => Answer | Error,
  over: { caps?: Decider["caps"]; shadow?: boolean; scrub?: (t: string) => string } = {},
) {
  const calls: { state: string; questions: Record<string, Question> }[] = [];
  const entries: ShadowEntry[] = [];
  const decider: Decider = {
    provider: "laya",
    model: "multilingual",
    caps: over.caps ?? CAPS.jev,
    uses: new Set(["repair-triage", "locator-heal"]),
    minConfidence: 0.75,
    scrub: over.scrub ?? ((t: string) => t),
    ...(over.shadow ? { shadow: { entries, record: (e: ShadowEntry) => void entries.push(e) } } : {}),
    summary: () => ({ provider: "laya", model: "multilingual", calls: calls.length, fallbacks: [] }),
    async decide(_use, state, questions) {
      calls.push({ state, questions: questions as Record<string, Question> });
      checkCaps(this.caps, state, questions as Record<string, Question>); // a refusal, as the real decider would
      return Object.fromEntries(
        Object.entries(questions as Record<string, Question>).map(([k, q]) => {
          const a = answer(q);
          if (a instanceof Error) throw a;
          return [k, a];
        }),
      ) as never;
    },
  };
  return { decider, calls, entries };
}

function fakeGateway(aria = PAGE, count = 1) {
  const observe = vi.fn(async () => ({ url: "http://app/login", screenshotB64: "", ariaSnapshot: aria, capturedBy: "lib" as const }));
  const verify = vi.fn(async (els: ElementRef[]) => els.map((e) => ({ ...e, count, verified: count === 1 })));
  return { gateway: { observe, verify } as unknown as BrowserGateway, observe, verify };
}

describe("makeHeal (spec §6.6)", () => {
  it("proposes the element the decider picks, verified to match once", async () => {
    const { decider, calls } = healDecider((q) => pick(optionFor(q, '"Sign in"')));
    const { gateway, observe, verify } = fakeGateway();
    const healed = await makeHeal({ decider, gateway, url: "http://app/login" })(failure(), triage());
    expect(healed).toEqual({
      test: "tc-1: signs in",
      from: "getByRole('button', { name: 'Sign' })",
      to: "getByRole('button', { name: 'Sign in', exact: true })",
      confidence: 0.9,
    });
    expect(observe).toHaveBeenCalledWith({ url: "http://app/login" });
    expect(verify).toHaveBeenCalledWith([expect.objectContaining({ role: "button", name: "Sign in" })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toContain("getByRole('button', { name: 'Sign' }) matched no element");
    expect(Object.keys((calls[0]!.questions.pick as Extract<Question, { type: "choice" }>).options)).toContain("none-of-these");
  });

  it("the element verified and proposed is the one picked, not the first offered", async () => {
    const { decider } = healDecider((q) => pick(optionFor(q, '"Create account"')));
    const { gateway, verify } = fakeGateway();
    const healed = await makeHeal({ decider, gateway, url: "u" })(failure(), triage());
    expect(verify).toHaveBeenCalledWith([expect.objectContaining({ name: "Create account" })]);
    expect(healed?.to).toBe("getByRole('button', { name: 'Create account', exact: true })");
  });

  it("a locator-ambiguous failure is healed too", async () => {
    const { decider, calls } = healDecider((q) => pick(optionFor(q, '"Sign in"')));
    const heal = makeHeal({ decider, gateway: fakeGateway().gateway, url: "http://app/login" });
    expect(await heal(failure(), triage("locator-ambiguous"))).toMatchObject({ confidence: 0.9 });
    expect(calls[0]!.state).toContain("matched several elements");
  });

  it("a long test name is clipped from the end: the broken locator still reaches the decider, within laya's cap", async () => {
    const { decider, calls } = healDecider((q) => pick(optionFor(q, '"Sign in"')), { caps: CAPS.laya });
    const heal = makeHeal({ decider, gateway: fakeGateway().gateway, url: "u" });
    expect(await heal(failure(BROKEN, `tc-1: ${"signs in ".repeat(200)}`), triage())).toMatchObject({ confidence: 0.9 });
    expect(calls[0]!.state).toContain("getByRole('button', { name: 'Sign' })");
    expect(calls[0]!.state.length).toBeLessThanOrEqual(500);
  });

  it.each(["timing", "wrong-assertion", "app-bug", "env-or-session"] as const)(
    "a %s verdict never starts a heal: no page, no question",
    async (category) => {
      const { decider, calls } = healDecider(() => pick("c1"));
      const { gateway, observe } = fakeGateway();
      expect(await makeHeal({ decider, gateway, url: "u" })(failure(), triage(category))).toBeUndefined();
      expect(observe).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    },
  );

  it("an error with no getByRole: nothing to heal, the page is not even opened", async () => {
    const { decider } = healDecider(() => pick("c1"));
    const { gateway, observe } = fakeGateway();
    expect(await makeHeal({ decider, gateway, url: "u" })(failure("Error: page.goto: net::ERR_ABORTED"), triage())).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("no candidate on the page: no question", async () => {
    const { decider, calls } = healDecider(() => pick("c1"));
    const heal = makeHeal({ decider, gateway: fakeGateway('- textbox "Email"').gateway, url: "u" });
    expect(await heal(failure(), triage())).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["none-of-these", pick("none-of-these")],
    ["a confidence below the threshold", pick("c1", 0.6)],
    ["a label never offered", pick("c99")],
    ["an answer of the wrong type", { type: "score", value: 2, dist: [0, 0, 1], confidence: 1 } as Answer],
  ])("%s → today's repair, nothing verified", async (_label, answer) => {
    const { decider } = healDecider(() => answer);
    const { gateway, verify } = fakeGateway();
    expect(await makeHeal({ decider, gateway, url: "u" })(failure(), triage())).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([0, 2, -1])("a pick that matches %i elements is refused", async (count) => {
    const { decider } = healDecider((q) => pick(optionFor(q, '"Sign in"')));
    expect(await makeHeal({ decider, gateway: fakeGateway(PAGE, count).gateway, url: "u" })(failure(), triage())).toBeUndefined();
  });

  it("a decider or a browser that fails leaves today's repair — and never throws", async () => {
    const dead = healDecider(() => new DeciderUnavailable("HTTP 500")).decider;
    expect(await makeHeal({ decider: dead, gateway: fakeGateway().gateway, url: "u" })(failure(), triage())).toBeUndefined();
    const { decider } = healDecider(() => pick("c1"));
    const broken = { observe: vi.fn(async () => Promise.reject(new Error("browser closed"))) } as unknown as BrowserGateway;
    expect(await makeHeal({ decider, gateway: broken, url: "u" })(failure(), triage())).toBeUndefined();
  });

  it("ASYMMETRY: the decider is never offered a destructive element or an incompatible role", async () => {
    const { decider, calls } = healDecider(() => pick("none-of-these"));
    await makeHeal({ decider, gateway: fakeGateway().gateway, url: "u" })(failure(), triage());
    const offered = Object.values((calls[0]!.questions.pick as Extract<Question, { type: "choice" }>).options).join(" | ");
    expect(offered).toContain('button "Sign in"');
    expect(offered).toContain('button "Create account"');
    expect(offered).not.toMatch(/Log out|Delete account|Sign in with Google|Email/);
  });

  it("the state and the options are scrubbed", async () => {
    const { decider, calls } = healDecider(() => pick("none-of-these"), { scrub: (t) => t.replaceAll("Sup3r!", "‹redacted›") });
    const page = '- button "Sign in as qa / Sup3r!"';
    await makeHeal({ decider, gateway: fakeGateway(page).gateway, url: "u" })(failure(BROKEN, "logs in with Sup3r!"), triage());
    expect(JSON.stringify(calls)).not.toContain("Sup3r!");
  });

  it("two stages when one choice would not fit laya: a score per candidate, then a choice among the best", async () => {
    const page = Array.from({ length: 25 }, (_, i) => `- button "Action ${i + 1}"`).join("\n");
    const { decider, calls } = healDecider(
      (q) =>
        q.type === "score"
          ? { type: "score", value: q.instructions.includes('"Action 17"') ? 2 : 0.5, dist: [0, 1, 0], confidence: 0.5 }
          : pick(optionFor(q, '"Action 17"')),
      { caps: CAPS.laya },
    );
    const healed = await makeHeal({ decider, gateway: fakeGateway(page).gateway, url: "u" })(failure(), triage());
    expect(healed?.to).toBe("getByRole('button', { name: 'Action 17', exact: true })");
    const scoreCalls = calls.filter((c) => Object.values(c.questions).every((q) => q.type === "score"));
    expect(scoreCalls.map((c) => Object.keys(c.questions).length)).toEqual([16, 9]); // chunked by the per-call cap
    const final = calls.at(-1)!.questions.pick as Extract<Question, { type: "choice" }>;
    expect(Object.keys(final.options).length).toBeLessThanOrEqual(11); // the best ten at most, plus none-of-these
    expect(Object.values(final.options).join()).toContain('"Action 17"');
  });

  it("two stages with long names: only the best that fit laya's question cap go into the final choice", async () => {
    const long = (i: number): string => `Step ${i} — ${"continue the onboarding flow ".repeat(3).trim()}`;
    const page = Array.from({ length: 25 }, (_, i) => `- button "${long(i + 1)}"`).join("\n");
    const { decider, calls } = healDecider(
      (q) =>
        q.type === "score"
          ? { type: "score", value: q.instructions.includes('"Step 17 ') ? 2 : 0.5, dist: [0, 1, 0], confidence: 0.5 }
          : pick(optionFor(q, '"Step 17 ')),
      { caps: CAPS.laya },
    );
    const healed = await makeHeal({ decider, gateway: fakeGateway(page).gateway, url: "u" })(failure(), triage());
    expect(healed?.to).toBe(locatorText({ role: "button", name: long(17) }));
    const final = calls.at(-1)!.questions.pick as Extract<Question, { type: "choice" }>;
    expect(Object.keys(final.options).length).toBeLessThan(11); // fewer than ten fit, and none were refused
  });

  it("two stages: a label scored but left out of the final choice is never trusted", async () => {
    const page = Array.from({ length: 25 }, (_, i) => `- button "Action ${i + 1}"`).join("\n");
    const { decider } = healDecider(
      (q) => (q.type === "score" ? { type: "score", value: q.instructions.includes('"Action 17"') ? 2 : 0.5, dist: [0, 1, 0], confidence: 0.5 } : pick("c25")),
      { caps: CAPS.laya },
    );
    const { gateway, verify } = fakeGateway(page);
    expect(await makeHeal({ decider, gateway, url: "u" })(failure(), triage())).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it("a long element name is clipped to fit laya's option cap, never refused for it", async () => {
    const long = `Continue with the ${"very ".repeat(30)}long flow`;
    const { decider, calls } = healDecider((q) => pick(optionFor(q, "Continue with")), { caps: CAPS.laya });
    const page = `- button "${long}"\n- button "Sign in"`;
    const healed = await makeHeal({ decider, gateway: fakeGateway(page).gateway, url: "u" })(failure(), triage());
    expect(healed?.to).toBe(locatorText({ role: "button", name: long })); // the proposal keeps the full name
    expect(calls).toHaveLength(1);
  });

  it("shadow: records what it would propose, verified or not, and proposes nothing", async () => {
    const { decider, entries } = healDecider((q) => pick(optionFor(q, '"Sign in"')), { shadow: true });
    const { gateway, verify } = fakeGateway();
    expect(await makeHeal({ decider, gateway, url: "u" })(failure(), triage())).toBeUndefined();
    expect(verify).toHaveBeenCalled();
    expect(entries).toEqual([
      expect.objectContaining({
        use: "locator-heal",
        // what was sent, as it was sent — never the raw error or the page
        input: {
          state: "Locator getByRole('button', { name: 'Sign' }) matched no element in Playwright test \"tc-1: signs in\".",
          candidates: ['button "Sign in"', 'button "Create account"'],
        },
        current: "repair",
        decider: { to: "getByRole('button', { name: 'Sign in', exact: true })", confidence: 0.9, verified: true },
        confidence: 0.9,
      }),
    ]);
  });

  it("shadow: an unavailable decider is recorded too", async () => {
    const { decider, entries } = healDecider(() => new DeciderUnavailable("timeout after 10000 ms"), { shadow: true });
    await makeHeal({ decider, gateway: fakeGateway().gateway, url: "u" })(failure(), triage());
    expect(entries).toEqual([expect.objectContaining({ use: "locator-heal", decider: { unavailable: "timeout after 10000 ms" } })]);
  });

  it("shadow: a doubtful pick is still verified and recorded — the threshold is the pilot's to calibrate", async () => {
    const { decider, entries } = healDecider((q) => pick(optionFor(q, '"Sign in"'), 0.6), { shadow: true });
    await makeHeal({ decider, gateway: fakeGateway().gateway, url: "u" })(failure(), triage());
    expect(entries[0]).toMatchObject({ decider: { verified: true, confidence: 0.6 }, confidence: 0.6 });
  });

  it("shadow: none-of-these is recorded as a decision, an unoffered label as a fallback", async () => {
    const none = healDecider(() => pick("none-of-these", 0.8), { shadow: true });
    await makeHeal({ decider: none.decider, gateway: fakeGateway().gateway, url: "u" })(failure(), triage());
    expect(none.entries[0]).toMatchObject({ decider: { to: null, confidence: 0.8 }, confidence: 0.8 });
    const stray = healDecider(() => pick("c99"), { shadow: true });
    await makeHeal({ decider: stray.decider, gateway: fakeGateway().gateway, url: "u" })(failure(), triage());
    expect(stray.entries[0]).toMatchObject({ decider: { unavailable: expect.stringMatching(/outside the offered candidates/) } });
  });

  it("shadow: nothing to heal → nothing recorded (another verdict, no getByRole, no candidate)", async () => {
    const { decider, entries } = healDecider(() => pick("c1"), { shadow: true });
    await makeHeal({ decider, gateway: fakeGateway().gateway, url: "u" })(failure(), triage("timing"));
    await makeHeal({ decider, gateway: fakeGateway().gateway, url: "u" })(failure("Error: page.goto: net::ERR_ABORTED"), triage());
    await makeHeal({ decider, gateway: fakeGateway('- textbox "Email"').gateway, url: "u" })(failure(), triage());
    expect(entries).toEqual([]);
  });
});

describe("lazyGateway — automate opens a browser only when a heal needs one", () => {
  it("opens nothing until used, once however often used, and closes what it opened", async () => {
    const { gateway, observe, verify } = fakeGateway();
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({ ...gateway, close }) as BrowserGateway);
    const lazy = lazyGateway(open);
    await lazy.close();
    expect(open).not.toHaveBeenCalled(); // never used: no browser, nothing to close
    await lazy.observe({ url: "u" });
    await lazy.verify([]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ url: "u" });
    expect(verify).toHaveBeenCalledWith([]);
    await lazy.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a browser that fails to open fails the heal — never the close at the end of the run", async () => {
    const lazy = lazyGateway(async () => Promise.reject(new Error("no chromium")));
    await expect(lazy.observe({ url: "u" })).rejects.toThrow("no chromium");
    await expect(lazy.close()).resolves.toBeUndefined();
  });
});
