import { describe, it, expect } from "vitest";
import { runExploreGraph, type ExploreDeps } from "../../src/agent/graph.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { RunWriter } from "../../src/artifacts/index.js";
import type { BrowserGateway, ClickEffect, Observation, Action } from "../../src/browser/index.js";
import type { ValidationReport } from "../../src/validate/index.js";
import type { PageStudy } from "../../src/observe/index.js";
import type { TestCase } from "../../src/design/index.js";
import type { Answer, Decider, DeciderUse, ShadowEntry } from "../../src/decider/types.js";
import { CAPS } from "../../src/decider/capabilities.js";

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
  writeOverlays: async () => undefined,
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
    overlays: false, // #225: these tests count clicks and observes of the page-level graph; overlays have their own tests
    ...over,
  };
}

describe("runExploreGraph — repair convergence (L1-04, Box 2)", () => {
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
    const out = await runExploreGraph(
      makeDeps({
        gateway,
        maxRepair: 5,
        validate: async () => {
          validateCalls += 1;
          return { ...stuck, results: [...stuck.results] };
        },
      }),
      { url: "https://app.test/page", runId: "r" },
    );

    // attempt 0 + ONE repair that makes no progress → stop. Without the guard it would be 1 + 5 = 6.
    expect(validateCalls).toBe(2);
    expect(out.stoppedEarly).toBe(true);
    // keep-best: the best (0.5) is preserved.
    expect(out.bestValidation?.greenRatio).toBe(0.5);
    expect(out.bestValidation).toBeDefined();
  });

  it("keeps repairing while progress is still being made (up to maxRepair)", async () => {
    // greenRatio climbs each attempt → never 'no progress' → bounded only by maxRepair.
    const ratios = [0.2, 0.4, 0.6];
    let i = 0;
    let validateCalls = 0;
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const out = await runExploreGraph(
      makeDeps({
        gateway,
        maxRepair: 2,
        validate: async () => {
          validateCalls += 1;
          const greenRatio = ratios[Math.min(i++, ratios.length - 1)] ?? 0.6;
          return { results: [{ test: "A", status: greenRatio >= 0.6 ? "passed" : "failed" }], greenRatio, flakyCount: 0 };
        },
      }),
      { url: "https://app.test/page", runId: "r" },
    );
    // attempt 0 + 2 repairs = 3 (progress every time → no early bail, capped by maxRepair=2).
    expect(validateCalls).toBe(3);
    expect(out.stoppedEarly).toBe(false);
  });
});

describe("runExploreGraph — browser/observe degradation (L1-04, Box 1)", () => {
  it("a navigation failure degrades to a readable message, never a raw stack", async () => {
    const { gateway } = fakeGateway(() => {
      throw new Error("page.goto: Timeout 30000ms exceeded\n    at navigate (pw.js:1:1)");
    });

    let err: Error | undefined;
    try {
      await runExploreGraph(makeDeps({ gateway, validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }) }), { url: "https://app.test/x", runId: "r" });
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
    await runExploreGraph(
      makeDeps({
        gateway,
        validate: async () => ({ results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 }),
      }),
      { url: "https://app.test/page", runId: "r" },
    );

    // it clicked the decline control (e2 = "Reject all") and re-observed the page.
    const clicks = acts.filter((a) => a.kind === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ kind: "click", ref: "e2" });
    expect(state.observe).toBeGreaterThanOrEqual(2);
  });
});

describe("runExploreGraph — durable artifacts (L1-04, #38)", () => {
  it("hands the study to onStudy as soon as observe succeeds, before a later node can fail", async () => {
    const seen: PageStudy[] = [];
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    await runExploreGraph(
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
      { url: "https://app.test/page", runId: "r" },
    ).catch(() => undefined);

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
    await runExploreGraph(
      makeDeps({
        gateway,
        onStudy: async (s) => {
          seen.push(s);
        },
        validate: async () => ({ results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 }),
      }),
      { url: "https://app.test/page", runId: "r" },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.elements.some((e) => e.name === "Reject all")).toBe(false); // re-observed after dismissal
    expect(seen[0]?.elements.some((e) => e.name === "Email")).toBe(true);
  });
});

describe("runExploreGraph — durable test cases (onTestCases)", () => {
  it("hands the cases to onTestCases as soon as designTestCases succeeds, before codegen/validate can fail", async () => {
    const seen: TestCase[][] = [];
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    await runExploreGraph(
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
      { url: "https://app.test/page", runId: "r" },
    ).catch(() => undefined);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBe(1); // the single sampleCase
  });

  it("fires onTestCases in codeless (design) mode too — the flow ends right after designTestCases", async () => {
    const seen: TestCase[][] = [];
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    await runExploreGraph(
      makeDeps({
        gateway,
        codeless: true,
        onTestCases: (cases) => {
          seen.push(cases);
        },
        validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }),
      }),
      { url: "https://app.test/page", runId: "r" },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBe(1);
  });
});

describe("runExploreGraph — decision layer (ADR-0022)", () => {
  const failing = (): ValidationReport => ({
    results: [{ test: "A", status: "failed", error: "500 Internal Server Error" }],
    greenRatio: 0,
    flakyCount: 0,
  });
  const fakeDecider = (uses: DeciderUse[]) => {
    const calls: string[] = [];
    const decider: Decider = {
      provider: "laya",
      model: "jev-latest",
      caps: { maxInputChars: 1200, maxQuestionChars: 400, maxOptions: 20, maxQuestionsPerCall: 16 },
      uses: new Set(uses),
      minConfidence: 0.75,
      scrub: (t: string) => t,
      summary: () => ({ provider: "laya", model: "jev-latest", calls: calls.length, fallbacks: [] }),
      async decide(use, _state, questions) {
        calls.push(use);
        const a: Answer = { type: "choice", value: "app-bug", dist: { "app-bug": 0.95 }, confidence: 0.9 };
        return Object.fromEntries(Object.keys(questions).map((k) => [k, a])) as never;
      },
    };
    return { decider, calls };
  };

  it("repair-triage on: a confident app bug is kept out of repair and reported in the outcome", async () => {
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const { decider, calls } = fakeDecider(["repair-triage"]);
    let validateCalls = 0;
    const out = await runExploreGraph(
      makeDeps({ gateway, decider, maxRepair: 3, validate: async () => (validateCalls++, failing()) }),
      { url: "https://app.test/page", runId: "r" },
    );
    expect(calls).toEqual(["repair-triage"]);
    expect(out.notRepaired).toEqual([{ test: "A", category: "app-bug", confidence: 0.9, exclude: true }]);
    expect(out.attempts).toBe(0);
    expect(validateCalls).toBe(1);
  });

  it("a decider whose uses leave out repair-triage is never asked during repair", async () => {
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const { decider, calls } = fakeDecider(["coverage"]);
    const out = await runExploreGraph(makeDeps({ gateway, decider, maxRepair: 1, validate: async () => failing() }), {
      url: "https://app.test/page",
      runId: "r",
    });
    expect(calls).toEqual([]);
    expect("notRepaired" in out).toBe(false);
    expect(out.attempts).toBe(1);
  });

  it("no decider → the outcome has no notRepaired key at all", async () => {
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const out = await runExploreGraph(makeDeps({ gateway, maxRepair: 1, validate: async () => failing() }), {
      url: "https://app.test/page",
      runId: "r",
    });
    expect("notRepaired" in out).toBe(false);
  });

  // locator-heal (spec §6.6): triage calls the failure a missing locator, heal picks c1 = "Sign in" on the page.
  const locatorDecider = (uses: DeciderUse[], shadow = false) => {
    const calls: string[] = [];
    const entries: ShadowEntry[] = [];
    const decider: Decider = {
      provider: "laya",
      model: "multilingual",
      caps: CAPS.laya,
      uses: new Set(uses),
      minConfidence: 0.75,
      scrub: (t: string) => t,
      ...(shadow ? { shadow: { entries, record: (e: ShadowEntry) => void entries.push(e) } } : {}),
      summary: () => ({ provider: "laya", model: "multilingual", calls: calls.length, fallbacks: [] }),
      async decide(use, _state, questions) {
        calls.push(use);
        const value = use === "repair-triage" ? "locator-missing" : "c1";
        const a: Answer = { type: "choice", value, dist: { [value]: 0.9 }, confidence: 0.9 };
        return Object.fromEntries(Object.keys(questions).map((k) => [k, a])) as never;
      },
    };
    return { decider, calls, entries };
  };
  const brokenThenGreen = () => {
    let n = 0;
    return async (): Promise<ValidationReport> =>
      n++ === 0
        ? { results: [{ test: "A", status: "failed", error: "waiting for getByRole('button', { name: 'Sign' })" }], greenRatio: 0, flakyCount: 0 }
        : { results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 };
  };

  it("locator-heal on: the verified replacement goes into repair and the outcome", async () => {
    const { gateway, state } = fakeGateway(() => obs('- button "Sign in"\n- button "Create account"'));
    const { decider, calls } = locatorDecider(["repair-triage", "locator-heal"]);
    const out = await runExploreGraph(makeDeps({ gateway, decider, maxRepair: 2, validate: brokenThenGreen() }), {
      url: "https://app.test/page",
      runId: "r",
    });
    expect(calls).toEqual(["repair-triage", "locator-heal"]);
    expect(out.healed).toEqual([
      { test: "A", from: "getByRole('button', { name: 'Sign' })", to: "getByRole('button', { name: 'Sign in', exact: true })", confidence: 0.9 },
    ]);
    expect(state.observe).toBeGreaterThan(1); // the heal re-observed the start page
  });

  it("a decider whose uses leave out locator-heal never heals", async () => {
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const { decider, calls } = locatorDecider(["repair-triage"]);
    const out = await runExploreGraph(makeDeps({ gateway, decider, maxRepair: 2, validate: brokenThenGreen() }), {
      url: "https://app.test/page",
      runId: "r",
    });
    expect(calls).toEqual(["repair-triage"]);
    expect("healed" in out).toBe(false);
  });

  it("shadow: heal is asked on triage's would-be verdict and recorded; repair runs as it would have", async () => {
    const { gateway } = fakeGateway(() => obs('- button "Sign in"'));
    const { decider, calls, entries } = locatorDecider(["repair-triage", "locator-heal"], true);
    const out = await runExploreGraph(makeDeps({ gateway, decider, maxRepair: 2, validate: brokenThenGreen() }), {
      url: "https://app.test/page",
      runId: "r",
    });
    expect(calls).toEqual(["repair-triage", "locator-heal"]);
    expect(entries.map((e) => e.use)).toEqual(["repair-triage", "locator-heal"]);
    expect("healed" in out).toBe(false);
    expect(out.attempts).toBe(1);
  });
});

describe("runExploreGraph — what each click did (#224)", () => {
  it("keeps the effect of every click the run makes: the consent dismissal and the probe's click and revert", async () => {
    const { gateway } = fakeGateway((call) =>
      call === 1 ? obs('- button "Reject all"\n- switch "Dark mode"') : obs('- switch "Dark mode"'),
    );
    gateway.getState = async () => ({ visible: true, enabled: true, checked: false });
    const effect = (name: string, outcome: "no-effect" | "state-changed"): ClickEffect => ({
      outcome, page: "https://app.test/page", role: "button", name, opened: [], closed: [], added: [], removed: [], appeared: [], state: [], requests: [],
    });
    let clicks = 0;
    gateway.act = async () =>
      clicks++ === 0
        ? { ok: true, ref: "e1", outcome: "state-changed", effect: effect("Reject all", "state-changed") }
        : { ok: true, ref: "e1", outcome: "no-effect", effect: effect("Dark mode", "no-effect") };
    const out = await runExploreGraph(
      makeDeps({ gateway, codeless: true, validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }) }),
      { url: "https://app.test/page", runId: "r" },
    );
    expect(out.clicks.map((c) => `${c.name}: ${c.outcome}`)).toEqual([
      "Reject all: state-changed",
      "Dark mode: no-effect",
      "Dark mode: no-effect",
    ]);
    expect(out.transitions[0]?.outcome).toBe("no-effect");
  });
});

describe("runExploreGraph — overlays as states (#225)", () => {
  const PAGE = '- main:\n  - button "Open settings"\n  - button "Save"';
  const DIALOG = '\n- dialog "Settings":\n  - textbox "Name"\n  - button "Save"\n  - button "Cancel"';

  /** A page whose "Open settings" opens a dialog; Escape closes it, a click outside does not. */
  function dialogPage(): { gateway: BrowserGateway; acts: Action[] } {
    let open = false;
    const acts: Action[] = [];
    const { gateway } = fakeGateway(() => obs(PAGE));
    const els = (aria: string) => aria.split("\n").filter((l) => l.trim().startsWith("- "));
    return {
      acts,
      gateway: {
        ...gateway,
        observe: async (opts) => {
          if (opts.url) open = false;
          return obs(open ? PAGE + DIALOG : PAGE);
        },
        act: async (action: Action) => {
          acts.push(action);
          if (action.kind === "press" && action.key === "Escape") open = false;
          if (action.kind === "click") {
            // refs are e1.. over the lines of the current snapshot; "Open settings" is the second line
            const line = els(open ? PAGE + DIALOG : PAGE)[Number(action.ref.slice(1)) - 1] ?? "";
            if (line.includes('"Open settings"') && !open) open = true;
          }
          return { ok: true, ref: "ref" in action ? action.ref : undefined };
        },
      },
    };
  }

  it("the overlays found go to the outcome, to design and to codegen; the page's Save is never pressed", async () => {
    const { gateway, acts } = dialogPage();
    const prompts: string[] = [];
    const spy = (value: unknown): StructuredInvoke =>
      (async (_schema: unknown, messages: unknown) => {
        prompts.push(JSON.stringify(messages));
        return value;
      }) as unknown as StructuredInvoke;
    const out = await runExploreGraph(
      makeDeps({
        gateway,
        overlays: true,
        designInvoke: spy({ testCases: [sampleCase] }),
        codegenInvoke: spy({ files: [{ path: "a.spec.ts", content: "// generated" }] }),
        validate: async () => ({ results: [{ test: "A", status: "passed" }], greenRatio: 1, flakyCount: 0 }),
      }),
      { url: "https://app.test/page", runId: "r" },
    );

    expect(out.overlays).toHaveLength(1);
    expect(out.overlays![0]).toMatchObject({ kind: "dialog", name: "Settings", trigger: { role: "button", name: "Open settings" } });
    expect(out.overlays![0]!.exits.find((x) => x.kind === "escape")).toMatchObject({ verified: true });
    expect(out.overlays![0]!.exits.find((x) => x.kind === "click-outside")).toMatchObject({ verified: false });
    expect(out.overlaySkipped).toEqual([{ role: "button", name: "Save", reason: "completes the form; not pressed" }]);
    // the design prompt carries the overlay and asks for the state-transition set
    const design = prompts.find((p) => p.includes("Overlays found on the page") && p.includes("state-transition"));
    expect(design).toBeTruthy();
    expect(design).toContain('dialog \\"Settings\\"');
    expect(design).toContain("Esc: it closes on Escape");
    // codegen: a dialog is its own component object
    expect(prompts.some((p) => p.includes("its OWN component object in the page-object model"))).toBe(true);
    // no click landed on the page's Save (e3)
    expect(acts.filter((a) => a.kind === "click" && a.ref === "e3")).toEqual([]);
  });

  it("overlays: false → the step does not run: no overlay in the outcome, no extra clicks", async () => {
    const { gateway, acts } = dialogPage();
    const out = await runExploreGraph(
      makeDeps({ gateway, validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }), codeless: true }),
      { url: "https://app.test/page", runId: "r" },
    );
    expect(out.overlays).toBeUndefined();
    expect(acts).toEqual([]);
  });

  it("a failure in the step keeps the page-level run (best effort)", async () => {
    const { gateway } = dialogPage();
    const broken: BrowserGateway = { ...gateway, act: async () => { throw new Error("boom"); } };
    const out = await runExploreGraph(
      makeDeps({ gateway: broken, overlays: true, codeless: true, validate: async () => ({ results: [], greenRatio: 0, flakyCount: 0 }) }),
      { url: "https://app.test/page", runId: "r" },
    );
    expect(out.testCases.length).toBeGreaterThan(0);
    expect(out.overlays).toEqual([]);
  });
});
