import { describe, it, expect } from "vitest";
import { crawlFlow, DESTRUCTIVE, flowReportPayload, flowSnapshotPath, type FlowNode } from "../../src/flow/crawl.js";
import { designJourneys } from "../../src/flow/journey.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";

/**
 * A scripted in-memory app: each page has an ARIA snapshot + a map ref→target page.
 * The fake gateway is a state machine — observe({url}) navigates, observe({}) returns the
 * current page, act(click) follows a link. Enough to exercise crawl WITHOUT a browser.
 */
interface FakePage {
  url: string;
  aria: string;
  links: Record<string, string>; // synthesized ref (e1, e2…) → target page key
}

function fakeGateway(pages: Record<string, FakePage>, startKey: string): BrowserGateway {
  let current = startKey;
  const keyOfUrl = (u: string): string =>
    Object.keys(pages).find((k) => pages[k]!.url === u) ?? startKey;
  return {
    observe: async ({ url }) => {
      if (url) current = keyOfUrl(url);
      const p = pages[current]!;
      return { url: p.url, screenshotB64: "", ariaSnapshot: p.aria, capturedBy: "lib" };
    },
    act: async ({ kind, ref }) => {
      if (kind === "click" && ref) {
        const target = pages[current]!.links[ref];
        if (target) current = target;
      }
      return { ok: true, ref };
    },
    verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
    getState: async () => ({ visible: true, enabled: true }),
    session: () => ({ load: async () => undefined, save: async () => ({ cookies: [], origins: [] }) }),
    runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
    close: async () => undefined,
  };
}

const aria = (lines: string[]): string => lines.join("\n");
const nodeFrom = (page: FakePage): FlowNode => {
  const study = {
    url: page.url,
    screenshotB64: "",
    ariaYaml: page.aria,
    capturedBy: "lib" as const,
    elements: parseAriaSnapshot(page.aria),
  };
  return { url: page.url, study, verified: study.elements.map((e) => ({ ...e, count: 1, verified: true })), transitions: [] };
};

describe("crawlFlow (#59)", () => {
  it("follows in-app links to build a page graph, bounded by maxPages", async () => {
    const pages: Record<string, FakePage> = {
      home: {
        url: "http://app/home",
        aria: aria(['- link "Dashboard"', '- link "Log out"', '- button "Save"']),
        links: { e1: "dash" }, // e1 = Dashboard link; e2 = Log out (destructive, must be skipped); e3 = button (not a link)
      },
      dash: {
        url: "http://app/dashboard",
        aria: aria(['- link "Home"', '- heading "Dashboard"']),
        links: { e1: "home" },
      },
    };
    const gw = fakeGateway(pages, "home");
    const graph = await crawlFlow(nodeFrom(pages.home!), { gateway: gw }, { maxPages: 2 });

    expect(graph.nodes.map((n) => n.url)).toEqual(["http://app/home", "http://app/dashboard"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "http://app/home", to: "http://app/dashboard", via: { ref: "e1" } });
  });

  it("never clicks a destructive (Log out) link — session safety", async () => {
    let loggedOut = false;
    const pages: Record<string, FakePage> = {
      home: { url: "http://app/home", aria: aria(['- link "Log out"']), links: { e1: "out" } },
      out: { url: "http://app/login", aria: aria(['- heading "Sign in"']), links: {} },
    };
    const gw = fakeGateway(pages, "home");
    const realAct = gw.act;
    gw.act = async (a) => {
      if (a.kind === "click" && a.ref === "e1") loggedOut = true;
      return realAct(a);
    };
    const graph = await crawlFlow(nodeFrom(pages.home!), { gateway: gw }, { maxPages: 5 });

    expect(loggedOut).toBe(false);
    expect(graph.nodes).toHaveLength(1); // only the start page
    expect(graph.edges).toHaveLength(0);
  });

  it("never follows a Ukrainian or Russian log-out link, and still follows one that only looks like it (#185)", async () => {
    const clicked: string[] = [];
    const pages: Record<string, FakePage> = {
      home: {
        url: "http://app/home",
        // e1, e2 end the session; e3, e4 are "Output data" pages (their names merely begin with the same letters)
        aria: aria(['- link "Вийти"', '- link "Выйти из аккаунта"', '- link "Вихідні дані"', '- link "Выходные данные"']),
        links: { e1: "login", e2: "login", e3: "outputUk", e4: "outputRu" },
      },
      login: { url: "http://app/login", aria: aria(['- heading "Вхід"']), links: {} },
      outputUk: { url: "http://app/output-uk", aria: aria(['- heading "Вихідні дані"']), links: {} },
      outputRu: { url: "http://app/output-ru", aria: aria(['- heading "Выходные данные"']), links: {} },
    };
    const gw = fakeGateway(pages, "home");
    const realAct = gw.act;
    gw.act = async (a) => {
      if (a.kind === "click" && a.ref) clicked.push(a.ref);
      return realAct(a);
    };
    const graph = await crawlFlow(nodeFrom(pages.home!), { gateway: gw }, { maxPages: 5 });

    expect(clicked).toEqual(["e3", "e4"]);
    expect(graph.nodes.map((n) => n.url)).toEqual(["http://app/home", "http://app/output-uk", "http://app/output-ru"]);
  });

  it("dedupes revisits and stays in-app (external links skipped)", async () => {
    const pages: Record<string, FakePage> = {
      home: {
        url: "http://app/home",
        aria: aria(['- link "Dashboard"', '- link "Docs"']),
        links: { e1: "dash", e2: "ext" },
      },
      dash: { url: "http://app/dashboard", aria: aria(['- link "Home"']), links: { e1: "home" } },
      ext: { url: "http://other.com/docs", aria: aria(['- heading "Docs"']), links: {} },
    };
    const gw = fakeGateway(pages, "home");
    const graph = await crawlFlow(nodeFrom(pages.home!), { gateway: gw }, { maxPages: 5 });

    // home + dashboard only; external other.com skipped; dashboard→home is a revisit (no new node)
    expect(graph.nodes.map((n) => n.url).sort()).toEqual(["http://app/dashboard", "http://app/home"]);
  });
});

/**
 * Client-routed SPA fake: act(click) sets a PENDING nav; the URL only "settles" when the next observe
 * is asked to waitForUrlChange — a bare observe still returns the OLD page. Without the #102 fix the
 * crawl observed without waiting → stale URL → 1-node graph.
 */
function spaGateway(pages: Record<string, FakePage>, startKey: string): BrowserGateway {
  let current = startKey;
  let pending: string | null = null;
  const keyOfUrl = (u: string): string => Object.keys(pages).find((k) => pages[k]!.url === u) ?? startKey;
  return {
    observe: async ({ url, waitForUrlChange }) => {
      if (url) {
        current = keyOfUrl(url);
        pending = null;
      } else if (waitForUrlChange && pending) {
        current = pending; // the SPA router finally updates the URL
        pending = null;
      }
      const p = pages[current]!;
      return { url: p.url, screenshotB64: "", ariaSnapshot: p.aria, capturedBy: "lib" };
    },
    act: async ({ kind, ref }) => {
      if (kind === "click" && ref) {
        const target = pages[current]!.links[ref];
        if (target) pending = target; // deferred — a bare observe still sees the source page
      }
      return { ok: true, ref };
    },
    verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
    getState: async () => ({ visible: true, enabled: true }),
    session: () => ({ load: async () => undefined, save: async () => ({ cookies: [], origins: [] }) }),
    runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
    close: async () => undefined,
  };
}

describe("crawlFlow — client-routed SPA (#102)", () => {
  it("follows SPA links whose URL settles only after waitForUrlChange → multi-node graph", async () => {
    const pages: Record<string, FakePage> = {
      home: {
        url: "http://app/",
        aria: aria(['- link "Platform"', '- link "Blog"']),
        links: { e1: "plat", e2: "blog" },
      },
      plat: { url: "http://app/platform", aria: aria(['- link "Home"']), links: { e1: "home" } },
      blog: { url: "http://app/blog", aria: aria(['- link "Home"']), links: { e1: "home" } },
    };
    const graph = await crawlFlow(nodeFrom(pages.home!), { gateway: spaGateway(pages, "home") }, { maxPages: 3 });

    expect(graph.nodes.length).toBeGreaterThan(1); // the bug produced exactly 1
    expect(graph.nodes.map((n) => n.url).sort()).toEqual([
      "http://app/",
      "http://app/blog",
      "http://app/platform",
    ]);
  });

  it("dedupes links by (name, href) so a repeated link isn't followed twice", async () => {
    let clicks = 0;
    const pages: Record<string, FakePage> = {
      home: {
        url: "http://app/",
        // 3 link rows, but two are the SAME (name + /url) — must collapse to one followed link.
        aria: aria([
          '- link "Platform":',
          "  - /url: /platform",
          '- link "Platform":',
          "  - /url: /platform",
          '- link "Blog":',
          "  - /url: /blog",
        ]),
        links: { e1: "plat", e2: "plat", e3: "blog" },
      },
      plat: { url: "http://app/platform", aria: aria(['- heading "Platform"']), links: {} },
      blog: { url: "http://app/blog", aria: aria(['- heading "Blog"']), links: {} },
    };
    const gw = spaGateway(pages, "home");
    const realAct = gw.act;
    gw.act = async (a) => {
      if (a.kind === "click") clicks += 1;
      return realAct(a);
    };
    await crawlFlow(nodeFrom(pages.home!), { gateway: gw }, { maxPages: 5 });

    expect(clicks).toBe(2); // 3 link rows → 2 unique (name, href) → 2 clicks (not 3)
  });

  it("a SPA crawl yields a multi-page graph → designJourneys can span ≥2 pages", async () => {
    const pages: Record<string, FakePage> = {
      home: { url: "http://app/", aria: aria(['- link "Platform"']), links: { e1: "plat" } },
      plat: { url: "http://app/platform", aria: aria(['- link "Home"']), links: { e1: "home" } },
    };
    const graph = await crawlFlow(nodeFrom(pages.home!), { gateway: spaGateway(pages, "home") }, { maxPages: 3 });
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);

    const fakeInvoke: StructuredInvoke = async (schema) =>
      schema.parse({
        journeys: [
          {
            title: "Home → Platform",
            technique: "state-transition",
            type: "Positive",
            preconditions: [],
            steps: [
              { page: "http://app/", action: "click Platform", elementRefs: [] },
              { page: "http://app/platform", action: "see platform", elementRefs: [] },
            ],
            expected: "platform page is shown",
            priority: "high",
          },
        ],
      });
    const journeys = await designJourneys({ graph }, { invoke: fakeInvoke, prompts: new PromptRegistry() });

    expect(journeys.length).toBeGreaterThanOrEqual(1);
    expect(new Set(journeys[0]!.steps.map((s) => s.page)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("flowSnapshotPath + flowReportPayload per-page snapshots (#103)", () => {
  it("builds an index-prefixed slug from the URL path; root → index", () => {
    expect(flowSnapshotPath(0, "http://app/")).toBe("snapshots/0-index");
    expect(flowSnapshotPath(1, "http://app/platform")).toBe("snapshots/1-platform");
    expect(flowSnapshotPath(2, "http://app/items/42")).toBe("snapshots/2-items-42");
  });

  it("keeps dirs unique via the index prefix even when two URLs slugify the same", () => {
    expect(flowSnapshotPath(0, "http://app/a/b")).not.toBe(flowSnapshotPath(1, "http://app/a/b"));
  });

  it("flowReportPayload exposes a per-page snapshot dir for every node (#103 ref in report.json)", () => {
    const home = nodeFrom({ url: "http://app/", aria: aria(['- link "X"']), links: {} });
    const plat = nodeFrom({ url: "http://app/platform", aria: aria(['- heading "P"']), links: {} });
    const payload = flowReportPayload({ nodes: [home, plat], edges: [] });
    expect(payload?.pages.map((p) => ({ url: p.url, snapshot: p.snapshot }))).toEqual([
      { url: "http://app/", snapshot: "snapshots/0-index" },
      { url: "http://app/platform", snapshot: "snapshots/1-platform" },
    ]);
  });
});

// #185 — the filter knows Ukrainian and Russian next to English. `\b` never fires next to Cyrillic, even with the `u`
// flag (`\w` stays ASCII), so those words are delimited by `\p{L}` lookarounds instead. A word counts in the forms a
// link or a button uses — the infinitive, the imperative (not that of «вийти»/«выйти»), the noun where it is itself the
// label (Вихід, Выход) — and never as a participle or an adjective of the same root. That is what the English filter
// does too: "Delete" counts, "Deleted items" does not.
describe("DESTRUCTIVE — destructive and session-ending names (#185)", () => {
  it("English: unchanged", () => {
    for (const t of ["Log out", "Sign out", "Logout", "Delete account", "Remove item", "Deactivate account", "Close account", "LOG OUT"]) {
      expect(DESTRUCTIVE.test(t), t).toBe(true);
    }
    for (const t of ["Log in", "Sign in", "Settings", "Deleted items", "Close", "Close window"]) {
      expect(DESTRUCTIVE.test(t), t).toBe(false);
    }
  });

  it("Ukrainian: log out, delete, remove, deactivate, close account", () => {
    for (const t of [
      "Вийти",
      "Вийти з акаунта",
      "Вихід",
      "Видалити",
      "Видалити акаунт",
      "Видалити обліковий запис",
      "Видаліть акаунт",
      "Вилучити з обраного",
      "Деактивувати акаунт",
      "Закрити обліковий запис",
      "ВИДАЛИТИ АКАУНТ",
    ]) {
      expect(DESTRUCTIVE.test(t), t).toBe(true);
    }
  });

  it("Russian: log out, delete, remove, deactivate, close account", () => {
    for (const t of [
      "Выйти",
      "Выйти из аккаунта",
      "Выход",
      "Удалить",
      "Удалить аккаунт",
      "Удалить учётную запись",
      "Удалите аккаунт",
      "Деактивировать аккаунт",
      "Закрыть аккаунт",
      "УДАЛИТЬ АККАУНТ",
    ]) {
      expect(DESTRUCTIVE.test(t), t).toBe(true);
    }
  });

  // Every form the pattern lists, bare: take one alternative out of the pattern and its row goes red. The account
  // phrases take each verb form and each noun once.
  it.each([
    // Ukrainian: log out, delete, remove, deactivate, close account
    "вийти",
    "вихід",
    "видалити",
    "видаляти",
    "видали",
    "видаліть",
    "вилучити",
    "вилучати",
    "вилучи",
    "вилучіть",
    "деактивувати",
    "деактивуй",
    "деактивуйте",
    "закрити акаунт",
    "закрий аккаунт",
    "закрийте обліковий запис",
    // Russian: log out, delete, deactivate, close account
    "выйти",
    "выход",
    "удалить",
    "удалять",
    "удали",
    "удалите",
    "деактивировать",
    "деактивируй",
    "деактивируйте",
    "закрыть аккаунт",
    "закрой учётную запись",
    "закройте учетную запись",
  ])("every listed form is refused: %s", (form) => {
    expect(DESTRUCTIVE.test(form), form).toBe(true);
  });

  it.each([
    ["Вихідні дані", "Output data: «вихідні» only begins like «вихід»"],
    ["Вихідні та святкові дні", "Weekends and holidays"],
    ["Вихідний код", "Source code"],
    ["Видалені елементи", "Deleted items: a folder, a state, not the action"],
    ["Видалений користувач", "the name a deleted user is shown under"],
    ["Політика видалення даних", "a noun: the policy page, not the action"],
    ["Закрити", "an ordinary Close button: only closing an account counts"],
    ["Закрити вікно", "Close window"],
    ["Вхід", "Log in"],
    ["Увійти", "Sign in"],
    ["Зберегти", "Save"],
    ["Выходные данные", "Output data: «выходные» only begins like «выход»"],
    ["Выходные и праздничные дни", "Weekends and holidays"],
    ["Удалённый доступ", "Remote access: «удалённый» is not «удалить»"],
    ["Удаленный рабочий стол", "Remote desktop, spelled without ё"],
    ["Удалённая работа", "Remote jobs"],
    ["Удалённые", "Deleted items: a folder, a state, not the action"],
    ["Закрыть", "an ordinary Close button: only closing an account counts"],
    ["Закрыть окно", "Close window"],
    ["Войти", "Sign in"],
    ["Сохранить", "Save"],
    // The word boundaries: a listed form that only begins, ends or sits inside another word is not that word.
    ["Вийти2", "a digit after it continues the word"],
    ["Вийти_", "an underscore after it continues the word"],
    ["Невийти", "a letter before it: another word, not «вийти»"],
    ["2Вийти", "a digit before it continues the word"],
    ["_Вийти", "an underscore before it continues the word"],
  ])("a name that only resembles a destructive one is followed: %s (%s)", (name) => {
    expect(DESTRUCTIVE.test(name), name).toBe(false);
  });

  it("the noun «вихід»/«выход» is refused in every sense, on purpose: a skipped link costs a page, a followed one the session", () => {
    // Like «Скинути вагу» for a reset: nothing in the word tells an exit of any kind from a log-out.
    for (const t of ["Вихід на пенсію", "Выход на посадку"]) {
      expect(DESTRUCTIVE.test(t), t).toBe(true);
    }
  });
});
