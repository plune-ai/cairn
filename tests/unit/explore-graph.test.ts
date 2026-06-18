import { describe, it, expect } from "vitest";
import { buildExploreGraph, type ExploreDeps } from "../../src/agent/graph.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { RunWriter } from "../../src/artifacts/index.js";
import type { BrowserGateway, Observation, Action } from "../../src/browser/index.js";
import type { ValidationReport } from "../../src/validate/index.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { TestCase } from "../../src/design/index.js";

/** A StructuredInvoke that ignores its args and yields a fixed value (no LLM). */
const fixed = (value: unknown): StructuredInvoke =>
  (async () => value) as unknown as StructuredInvoke;

const sampleCase = {
  title: "loads the page",
  technique: "exploratory",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["open the page"],
  expected: "the page renders",
  priority: "high",
  elementRefs: [],
};

const obs = (aria: string): Observation => ({
  url: "https://app.test/page",
  screenshotB64: "",
  ariaSnapshot: aria,
  capturedBy: "lib",
  consoleErrors: [],
});

interface FakeGateway {
  gateway: BrowserGateway;
  acts: Action[];
  state: { observe: number };
}

/** Minimal in-memory gateway. `observeImpl(callNumber)` returns the observation (or throws). */
function fakeGateway(observeImpl: (call: number) => Observation): FakeGateway {
  const acts: Action[] = [];
  const state = { observe: 0 };
  const gateway: BrowserGateway = {
    observe: async () => {
      state.observe += 1;
      return observeImpl(state.observe);
    },
    act: async (action) => {
      acts.push(action);
      return { ok: true, ref: "ref" in action ? action.ref : undefined };
    },
    verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
    getState: async () => ({ visible: false, enabled: false }),
    session: () => {
      throw new Error("fake: no session");
    },
    runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
    close: async () => undefined,
  };
  return { gateway, acts, state };
}

const fakeRunWriter = (): RunWriter => ({
  runId: "test-run",
  dir: "/tmp/test-run",
  writeStudy: async () => undefined,
  writeSuite: async () => [],
  writeReport: async () => undefined,
  writeScreenshot: async () => undefined,
  writeAria: async () => undefined,
  writeReportMd: async () => undefined,
  writeLog: async () => undefined,
  writeTestCases: async () => [],
});

function makeDeps(over: Partial<ExploreDeps> & Pick<ExploreDeps, "gateway" | "validate">): ExploreDeps {
  return {
    prompts: new PromptRegistry(),
    analyzeInvoke: fixed({ pageSemantics: "A login page", primaryRefs: [], viewSwitchers: [] }),
    designInvoke: fixed({ testCases: [sampleCase] }),
    codegenInvoke: fixed({ files: [{ path: "a.spec.ts", content: "// generated" }] }),
    useVision: false,
    runWriter: fakeRunWriter(),
    maxRepair: 5,
    ...over,
  };
}

describe("buildExploreGraph — repair convergence (L1-04, Box 2)", () => {
  it("bails early when an attempt makes no progress (does NOT burn all maxRepair attempts)", async () => {
    const stuck: ValidationReport = {
      results: [
        { test: "A", status: "passed" },
        { test: "B", status: "failed" },
      ],
      greenRatio: 0.5,
      flakyCount: 0,
    };
    let validateCalls = 0;
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        maxRepair: 5,
        validate: async () => {
          validateCalls += 1;
          return { ...stuck, results: [...stuck.results] };
        },
      }),
    );

    const out = await graph.invoke({ url: "https://app.test/page", runId: "r" });

    // attempt 0 + ONE repair that makes no progress → stop. Without the guard it would be 1 + 5 = 6.
    expect(validateCalls).toBe(2);
    expect(out.stoppedEarly).toBe(true);
    // keep-best: the best (0.5) is preserved.
    expect(out.bestGreen).toBe(0.5);
    expect(out.bestValidation).toBeDefined();
  });

  it("keeps repairing while progress is still being made (up to maxRepair)", async () => {
    // greenRatio climbs each attempt → never 'no progress' → bounded only by maxRepair.
    const ratios = [0.2, 0.4, 0.6];
    let i = 0;
    let validateCalls = 0;
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        maxRepair: 2,
        validate: async () => {
          validateCalls += 1;
          const greenRatio = ratios[Math.min(i++, ratios.length - 1)] ?? 0.6;
          return { results: [{ test: "A", status: greenRatio >= 0.6 ? "passed" : "failed" }], greenRatio, flakyCount: 0 };
        },
      }),
    );

    const out = await graph.invoke({ url: "https://app.test/page", runId: "r" });
    // attempt 0 + 2 repairs = 3 (progress every time → no early bail, capped by maxRepair=2).
    expect(validateCalls).toBe(3);
    expect(out.stoppedEarly).toBe(false);
  });
});

describe("buildExploreGraph — browser/observe degradation (L1-04, Box 1)", () => {
  it("a navigation failure degrades to a readable message, never a raw stack", async () => {
    const { gateway } = fakeGateway(() => {
      throw new Error("page.goto: Timeout 30000ms exceeded\n    at navigate (pw.js:1:1)");
    });
    const graph = buildExploreGraph(makeDeps({ gateway, validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }) }));

    let err: Error | undefined;
    try {
      await graph.invoke({ url: "https://app.test/x", runId: "r" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeTruthy();
    expect(err!.message.toLowerCase()).toMatch(/could not load|timed out/);
    expect(err!.message).toContain("https://app.test/x");
    expect(err!.message).not.toMatch(/\n\s+at /); // no stack frames leaked
  });

  it("auto-dismisses a consent wall (declines) before studying the page", async () => {
    const { gateway, acts, state } = fakeGateway((call) =>
      call === 1
        ? obs('- button "Accept all"\n- button "Reject all"\n- button "Sign in"')
        : obs('- button "Sign in"'),
    );
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        validate: async () => ({ results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 }),
      }),
    );

    await graph.invoke({ url: "https://app.test/page", runId: "r" });

    // it clicked the decline control (e2 = "Reject all") and re-observed the page.
    const clicks = acts.filter((a) => a.kind === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ kind: "click", ref: "e2" });
    expect(state.observe).toBeGreaterThanOrEqual(2);
  });
});

describe("buildExploreGraph — durable artifacts (L1-04, #38)", () => {
  it("hands the study to onStudy as soon as observe succeeds, before a later node can fail", async () => {
    const seen: PageStudy[] = [];
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        onStudy: async (s) => {
          seen.push(s);
        },
        // a later node throws → proves the study was already persisted before the failure.
        validate: async () => {
          throw new Error("boom after observe");
        },
      }),
    );

    await graph.invoke({ url: "https://app.test/page", runId: "r" }).catch(() => undefined);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.elements.length).toBeGreaterThan(0);
  });

  it("persists the POST-consent study (the wall is already gone)", async () => {
    const seen: PageStudy[] = [];
    const { gateway } = fakeGateway((call) =>
      call === 1
        ? obs('- button "Reject all"\n- button "Sign in"')
        : obs('- button "Sign in"\n- textbox "Email"'),
    );
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        onStudy: async (s) => {
          seen.push(s);
        },
        validate: async () => ({ results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 }),
      }),
    );

    await graph.invoke({ url: "https://app.test/page", runId: "r" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.elements.some((e) => e.name === "Reject all")).toBe(false); // re-observed after dismissal
    expect(seen[0]?.elements.some((e) => e.name === "Email")).toBe(true);
  });
});

describe("buildExploreGraph — durable test cases (onTestCases)", () => {
  it("hands the cases to onTestCases as soon as designTestCases succeeds, before codegen/validate can fail", async () => {
    const seen: TestCase[][] = [];
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        onTestCases: (cases) => {
          seen.push(cases);
        },
        // a later node throws → proves the cases were already persisted before the failure.
        validate: async () => {
          throw new Error("boom after design");
        },
      }),
    );

    await graph.invoke({ url: "https://app.test/page", runId: "r" }).catch(() => undefined);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBe(1); // the single sampleCase
  });

  it("fires onTestCases in codeless (design) mode too — the flow ends right after designTestCases", async () => {
    const seen: TestCase[][] = [];
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const graph = buildExploreGraph(
      makeDeps({
        gateway,
        codeless: true,
        onTestCases: (cases) => {
          seen.push(cases);
        },
        validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }),
      }),
    );

    await graph.invoke({ url: "https://app.test/page", runId: "r" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBe(1);
  });
});
