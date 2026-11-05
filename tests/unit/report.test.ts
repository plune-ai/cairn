import { describe, it, expect } from "vitest";
import { renderReportMd, renderApiReportMd, locatorFor, deadClicksOf } from "../../src/artifacts/report.js";
import type { ClickEffect, ElementRef } from "../../src/browser/types.js";
import type { ApiCaseResult } from "../../src/api/runner.js";

const btn: ElementRef = { ref: "e6", role: "button", name: "Sign In", interactive: true, rank: 3 };

describe("locatorFor", () => {
  it("getByRole with name", () => {
    expect(locatorFor(btn)).toBe("page.getByRole('button', { name: 'Sign In' })");
  });
  it("getByRole without name", () => {
    expect(locatorFor({ ref: "e1", role: "main", interactive: false, rank: 1 })).toBe(
      "page.getByRole('main')",
    );
  });
  it("escapes apostrophes in the name", () => {
    expect(locatorFor({ ref: "e2", role: "button", name: "Кошик'ок", interactive: true, rank: 3 })).toContain(
      "Кошик\\'ок",
    );
  });
});

describe("renderReportMd", () => {
  it("contains url, selector, case, validation %", () => {
    const md = renderReportMd({
      runId: "r1",
      url: "http://x/login",
      backend: "lib",
      profile: "openrouter",
      pageSemantics: "Форма логіну",
      elements: [btn],
      testCases: [
        {
          id: "tc-1",
          title: "Логін",
          technique: "exploratory",
          preconditions: [],
          steps: ["Натиснути Sign In"],
          expected: "OK",
          priority: "high",
          elementRefs: ["e6"],
        },
      ],
      validation: { results: [{ test: "Логін", status: "passed" }], greenRatio: 1, flakyCount: 0 },
      scores: [{ name: "runs_green", value: 1 }, { name: "grounding", value: 0.75 }],
    });
    expect(md).toContain("http://x/login");
    expect(md).toContain("getByRole('button', { name: 'Sign In' })");
    expect(md).toContain("tc-1");
    expect(md).toContain("Логін");
    expect(md).toContain("100%");
    expect(md).toContain("Metrics");
    expect(md).toContain("grounding");
  });

  it("annotates each metric with a ↑/↓ direction, a meaning blurb, and a judge tag + key line", () => {
    const md = renderReportMd({
      runId: "r1",
      url: "http://x/login",
      backend: "lib",
      profile: "anthropic",
      pageSemantics: "Форма логіну",
      elements: [btn],
      testCases: [],
      scores: [
        { name: "grounding", value: 1 },
        { name: "case_redundancy", value: 0 },
        { name: "test_case_quality", value: 0.8, comment: "clear" },
        { name: "mystery_metric", value: 0.5 }, // unknown → graceful: no glyph, empty meaning
      ],
    });
    // key line explaining the glyphs + "judge"
    expect(md).toContain("↑ higher is better");
    expect(md).toContain("↓ lower is better");
    expect(md).toContain("judge = scored by an LLM");
    // new column + per-metric annotations
    expect(md).toContain("meaning");
    expect(md).toContain("grounding ↑");
    expect(md).toContain("case_redundancy ↓");
    expect(md).toContain("test_case_quality ↑ (judge)");
    // the blurb text comes from the legend
    expect(md).toContain("near-duplicates");
    expect(md).toContain("Holistic quality");
    // value + comment are preserved
    expect(md).toContain("0.80");
    expect(md).toContain("clear");
    // unknown metric still renders its row (no glyph), doesn't crash
    expect(md).toContain("mystery_metric");
  });

  it("renders a per-role Cost section when cost is provided (L1-01)", () => {
    const md = renderReportMd({
      runId: "r2",
      url: "http://x/app",
      backend: "lib",
      profile: "anthropic",
      pageSemantics: "App",
      elements: [btn],
      testCases: [],
      cost: {
        perRole: [
          { role: "worker", models: ["deepseek/deepseek-chat"], calls: 2, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.001 },
          { role: "reasoner", models: ["claude-opus-4-8"], calls: 1, inputTokens: 800, outputTokens: 400, totalTokens: 1200, costUsd: 0.014 },
        ],
        totalTokens: 2700,
        totalCostUsd: 0.015,
      },
    });
    expect(md).toContain("Cost (per role)");
    expect(md).toContain("worker");
    expect(md).toContain("reasoner");
    expect(md).toContain("deepseek/deepseek-chat");
    expect(md).toContain("$0.0140");
    expect(md).toContain("$0.0150"); // total
  });

  it("renders '—' for an unknown (null) cost without crashing", () => {
    const md = renderReportMd({
      runId: "r3",
      url: "http://x/app",
      backend: "lib",
      profile: "openrouter",
      pageSemantics: "App",
      elements: [],
      testCases: [],
      cost: {
        perRole: [{ role: "worker", models: ["mystery"], calls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null }],
        totalTokens: 15,
        totalCostUsd: null,
      },
    });
    expect(md).toContain("Cost (per role)");
    expect(md).toMatch(/\bworker\b.*—/);
  });
});

describe("renderReportMd — decision layer sections (ADR-0022)", () => {
  const base = {
    runId: "r1",
    url: "http://x/login",
    backend: "lib",
    profile: "anthropic",
    pageSemantics: "Login form",
    elements: [btn],
    testCases: [],
    validation: { results: [{ test: "TC-3", status: "failed" as const, error: "500" }], greenRatio: 0, flakyCount: 0 },
  };

  it("without a decider the report is byte-identical: no section, no mention", () => {
    const md = renderReportMd(base);
    expect(renderReportMd({ ...base, notRepaired: undefined, decider: undefined })).toBe(md);
    expect(renderReportMd({ ...base, notRepaired: [] })).toBe(md);
    expect(md).not.toMatch(/decision layer|not repaired/i);
  });

  it("lists the tests triage kept out of repair, so nobody mistakes them for a test problem", () => {
    const md = renderReportMd({
      ...base,
      notRepaired: [{ test: "TC-3", category: "app-bug", confidence: 0.912, exclude: true }],
    });
    expect(md).toContain("## Not repaired — likely an app bug or a broken environment (1)");
    expect(md).toContain("| TC-3 | app-bug | 0.91 |");
  });

  it("names every healed locator, was → now, so a reviewer sees the test now targets another element", () => {
    const md = renderReportMd({
      ...base,
      healed: [{ test: "TC-3", from: "getByRole('button', { name: 'A|B' })", to: "getByRole('button', { name: 'A|B!', exact: true })", confidence: 0.904 }],
    });
    expect(md).toContain("## Locators healed (1)");
    expect(md).toContain("| TC-3 | `getByRole('button', { name: 'A\\|B' })` | `getByRole('button', { name: 'A\\|B!', exact: true })` | 0.90 |");
    expect(renderReportMd({ ...base, healed: [] })).toBe(renderReportMd(base));
  });

  it("summarises the decider: provider, calls, and fallbacks grouped by use and reason", () => {
    const md = renderReportMd({
      ...base,
      decider: {
        provider: "laya",
        model: "jev-latest",
        calls: 5,
        fallbacks: [
          { use: "repair-triage", reason: "HTTP 500" },
          { use: "repair-triage", reason: "HTTP 500" },
          { use: "coverage", reason: "state is 1500 chars > 1200" },
        ],
      },
    });
    expect(md).toContain("## Decision layer");
    expect(md).toContain("- **Provider:** laya · model jev-latest");
    expect(md).toContain("- **Decisions:** 5 · **answered:** 2 · **fallbacks:** 3 (the current path ran instead)");
    expect(md).toContain("  - repair-triage — HTTP 500 (×2)");
    expect(md).toContain("  - coverage — state is 1500 chars > 1200 (×1)");
  });
});

describe("renderReportMd — dead clicks (#224)", () => {
  const base = { runId: "r1", url: "http://x/login", backend: "lib", profile: "anthropic", pageSemantics: "Login form", elements: [btn], testCases: [] };
  const click = (outcome: ClickEffect["outcome"], name: string, page = "http://x/login", role = "button"): ClickEffect => ({
    outcome, page, role, name, opened: [], closed: [], added: [], removed: [], appeared: [], state: [], requests: [],
  });

  it("lists each click Cairn saw no change after, with its element and page, once per element", () => {
    const dead = deadClicksOf([
      click("no-effect", "Export"),
      click("state-changed", "Remember me"),
      click("no-effect", "Export"), // exploreStates clicks the same element again
      click("network-only", "Save"),
      click("unknown", "Sync"), // could not be judged: not a dead click
      click("no-effect", "Export", "http://x/list"),
    ]);
    expect(dead).toEqual([
      { page: "http://x/login", role: "button", name: "Export" },
      { page: "http://x/list", role: "button", name: "Export" },
    ]);
    const md = renderReportMd({ ...base, deadClicks: dead });
    expect(md).toContain("## Dead clicks (2)");
    expect(md).toContain("Cairn saw no change within 1200 ms of each click below — check it by hand.");
    expect(md).toMatch(/It cannot see: .*no answer within 2000 ms/);
    expect(md).not.toContain("changed nothing");
    expect(md).toContain('| http://x/login | button "Export" |');
    expect(md).toContain('| http://x/list | button "Export" |');
  });

  it("a link the crawl followed to another page is not dead, even when its click looked quiet", () => {
    const quietLink = click("no-effect", "Pricing", "http://x/", "link");
    const edges = [{ from: "http://x", to: "http://x/pricing", via: { ref: "e3", role: "link", name: "Pricing" } }];
    expect(deadClicksOf([quietLink], edges)).toEqual([]);
    // A link the crawl saw land on the same page stays dead.
    expect(deadClicksOf([quietLink], [{ ...edges[0]!, to: "http://x/#top" }])).toHaveLength(1);
  });

  it("the page of a dead click keeps no query value, no fragment and no user", () => {
    const dead = deadClicksOf([click("no-effect", "Export", "http://jdoe:pw@x/orders?token=abc123XYZ789#k=1")]);
    expect(dead).toEqual([{ page: "http://x/orders?token=‹v›", role: "button", name: "Export" }]);
  });

  it("the section is there, and empty, when every click had an effect", () => {
    for (const md of [renderReportMd({ ...base, deadClicks: [] }), renderReportMd(base)]) {
      expect(md).toContain("## Dead clicks (0)");
      expect(md).toContain("None: Cairn saw a change within 1200 ms of every click it could judge.");
      expect(md).not.toContain("| page | element |");
    }
  });

  it("on the cli backend the section says the clicks were not recorded, not that there were none", () => {
    const md = renderReportMd({ ...base, backend: "cli" });
    expect(md).toContain("## Dead clicks");
    expect(md).toContain("Not recorded on the cli backend.");
    expect(md).not.toContain("None:");
  });

  it("a request the guard stopped is not called a write for certain: an app may read through POST (#225 review 5)", () => {
    const md = renderReportMd({ ...base, overlayGuard: { guard: "network", blocked: [{ method: "POST", path: "/graphql", count: 1 }] } });
    expect(md).toContain("### Requests stopped while exploring overlays (1)");
    expect(md).toMatch(/method is not GET, HEAD or OPTIONS/);
    expect(md).toMatch(/not necessarily a write/);
    expect(md).not.toMatch(/Writes stopped/);
    expect(md).toContain("| POST | /graphql | — | 1 |");
  });
});

describe("renderApiReportMd (C1-04 / API-4, #134)", () => {
  const results: ApiCaseResult[] = [
    {
      name: "listPets",
      method: "GET",
      url: "https://api.test/pets",
      request: { headers: {} },
      response: { status: 200, bodyText: "[]", json: [] },
      attempts: 1,
      expectedStatus: "200",
      statusOk: true,
      schemaOk: true,
      schemaErrors: [],
      passed: true,
    },
    {
      name: "createPet",
      method: "POST",
      url: "https://api.test/pets",
      request: { headers: {} },
      response: { status: 500, bodyText: "", json: undefined },
      attempts: 1,
      expectedStatus: "201",
      statusOk: false,
      schemaOk: true,
      schemaErrors: [],
      passed: false,
    },
  ];

  it("contains base URL, per-operation pass/fail marks, endpoint coverage, and the evidence path", () => {
    const md = renderApiReportMd({
      runId: "api-1",
      baseUrl: "https://api.test",
      source: "petstore.yaml",
      results,
      endpointCount: 2,
      evidencePath: "/tmp/runs/api-1/api-evidence.json",
    });
    expect(md).toContain("https://api.test");
    expect(md).toContain("petstore.yaml");
    expect(md).toContain("1/2 passed");
    expect(md).toContain("2 endpoint(s) covered");
    expect(md).toContain("/tmp/runs/api-1/api-evidence.json");
    expect(md).toMatch(/✓ \| GET/);
    expect(md).toMatch(/✗ \| POST/);
  });

  it("renders a Coverage section (gaps only) when `coverage` is supplied (API-6, #136)", () => {
    const md = renderApiReportMd({
      runId: "api-1",
      baseUrl: "https://api.test",
      source: "petstore.yaml",
      results,
      endpointCount: 2,
      evidencePath: "/tmp/runs/api-1/api-evidence.json",
      coverage: {
        endpointCount: 2,
        coveredCount: 1,
        partialCount: 1,
        uncoveredCount: 0,
        ratio: 0.5,
        endpoints: [
          {
            method: "GET",
            path: "/pets",
            operationId: "listPets",
            deprecated: false,
            status: "covered",
            declaredStatuses: ["200"],
            testedStatuses: ["200"],
          },
          {
            method: "GET",
            path: "/pets/{id}",
            operationId: "getPet",
            deprecated: false,
            status: "partial",
            declaredStatuses: ["200", "404"],
            testedStatuses: ["200"],
          },
        ],
      },
    });
    expect(md).toContain("Coverage (1/2 endpoint(s) — 50%)");
    expect(md).toContain("⚠ partial | GET | /pets/{id} | getPet | 200 | 404");
    expect(md).not.toContain("listPets |"); // fully-covered rows are omitted — gaps only
  });

  it("omits the Coverage section entirely when `coverage` is absent (back-compat)", () => {
    const md = renderApiReportMd({
      runId: "api-1",
      baseUrl: "https://api.test",
      source: "petstore.yaml",
      results,
      endpointCount: 2,
      evidencePath: "/tmp/runs/api-1/api-evidence.json",
    });
    expect(md).not.toContain("## Coverage");
  });
});
