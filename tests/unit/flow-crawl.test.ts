import { describe, it, expect } from "vitest";
import { crawlFlow, type FlowNode } from "../../src/flow/crawl.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";
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
