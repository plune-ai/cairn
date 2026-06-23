import { describe, it, expect } from "vitest";
import { crawlFlow, flowReportPayload, flowSnapshotPath, type FlowNode } from "../../src/flow/crawl.js";
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
