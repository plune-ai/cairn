import { describe, it, expect, vi, afterEach } from "vitest";
import { probeTransitions } from "../../src/probe/index.js";
import type { BrowserGateway } from "../../src/browser/index.js";
import type { ElementRef, ElementState } from "../../src/browser/types.js";

function fakeGateway(states: ElementState[], onClick: () => void): BrowserGateway {
  let i = 0;
  return {
    observe: async () => ({ url: "", screenshotB64: "", ariaSnapshot: "", capturedBy: "lib" }),
    act: async () => {
      onClick();
      return { ok: true };
    },
    verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
    getState: async () => states[Math.min(i++, states.length - 1)] as ElementState,
    session: () => ({ load: async () => undefined, save: async () => ({ cookies: [], origins: [] }) }),
    runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
    close: async () => undefined,
  };
}

describe("probeTransitions (act→observe, safe roles)", () => {
  it("switch → before→after transition; button is skipped; revert click is performed", async () => {
    let clicks = 0;
    const gw = fakeGateway(
      [
        { visible: true, enabled: true, checked: false },
        { visible: true, enabled: true, checked: true },
      ],
      () => {
        clicks += 1;
      },
    );
    const els: ElementRef[] = [
      { ref: "e1", role: "switch", name: "Toggle", interactive: true, rank: 3 },
      { ref: "e2", role: "button", name: "Submit", interactive: true, rank: 3 },
    ];
    const t = await probeTransitions(gw, els);
    expect(t).toHaveLength(1);
    expect(t[0]?.ref).toBe("e1");
    expect(t[0]?.before.checked).toBe(false);
    expect(t[0]?.after.checked).toBe(true);
    expect(clicks).toBe(2); // click + revert click
  });

  it("disabled switch → skipped (no click)", async () => {
    let clicks = 0;
    const gw = fakeGateway([{ visible: true, enabled: false, checked: false }], () => {
      clicks += 1;
    });
    const t = await probeTransitions(gw, [{ ref: "e1", role: "switch", interactive: true, rank: 3 }]);
    expect(t).toHaveLength(0);
    expect(clicks).toBe(0);
  });
});

describe("probeTransitions has an end (#213)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const switches = (n: number): ElementRef[] =>
    Array.from({ length: n }, (_, i) => ({ ref: `e${i + 1}`, role: "switch", name: `Toggle ${i + 1}`, interactive: true, rank: 3 }));
  /** A gateway whose reads of the refs in `stuck` never answer; the others flip on the first click. */
  function stuckGateway(stuck: Set<string>): BrowserGateway & { reads: string[] } {
    const reads: string[] = [];
    const clicked = new Set<string>();
    return {
      ...fakeGateway([], () => undefined),
      reads,
      act: async (action) => {
        if ("ref" in action) clicked.add(action.ref);
        return { ok: true };
      },
      getState: (el) => {
        reads.push(el.ref);
        if (stuck.has(el.ref)) return new Promise<ElementState>(() => undefined);
        return Promise.resolve({ visible: true, enabled: true, checked: clicked.has(el.ref) });
      },
    };
  }

  it("an element that never answers is skipped after its limit, said in the log, and the next one is probed", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const gw = stuckGateway(new Set(["e1"]));
    const run = probeTransitions(gw, switches(2), { elementTimeoutMs: 1_000, onProgress: (e) => log.push(e) });
    await vi.advanceTimersByTimeAsync(1_000);
    const t = await run;
    expect(t.map((x) => x.ref)).toEqual(["e2"]);
    expect(log).toContain('probeInteractions — skipped e1 (switch "Toggle 1"): no answer in 1000 ms');
  });

  it("the step stops at its own limit: the elements left are not touched, the log says how far it got", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const gw = stuckGateway(new Set(["e1", "e2", "e3", "e4", "e5"]));
    const run = probeTransitions(gw, switches(5), { elementTimeoutMs: 1_000, budgetMs: 2_500, onProgress: (e) => log.push(e) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toEqual([]);
    expect(gw.reads).toEqual(["e1", "e2", "e3"]);
    expect(log).toContain("probeInteractions — stopped at the 2500 ms limit: 3 of 5 safe elements tried");
  });

  it("clicks with a 2 s limit, not the backend's 30 s default, the revert too", async () => {
    const acts: unknown[] = [];
    const gw = stuckGateway(new Set());
    gw.act = async (action) => {
      acts.push(action);
      return { ok: true };
    };
    await probeTransitions(gw, switches(1));
    expect(acts).toEqual([
      { kind: "click", ref: "e1", timeoutMs: 2_000 },
      { kind: "click", ref: "e1", timeoutMs: 2_000 },
    ]);
  });

  it("a read that answers after the element was skipped clicks nothing", async () => {
    vi.useFakeTimers();
    const acts: unknown[] = [];
    const gw = stuckGateway(new Set());
    gw.getState = () => new Promise((resolve) => setTimeout(() => resolve({ visible: true, enabled: true, checked: false }), 5_000));
    gw.act = async (action) => {
      acts.push(action);
      return { ok: true };
    };
    const run = probeTransitions(gw, switches(1), { elementTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toEqual([]);
    expect(acts).toEqual([]);
  });

  it("an error that is not the limit still reaches the caller", async () => {
    const gw = stuckGateway(new Set());
    gw.getState = () => Promise.reject(new Error("browser closed"));
    await expect(probeTransitions(gw, switches(1))).rejects.toThrow("browser closed");
  });

  it("says how far it got every 10 safe elements, so a slow step is seen to move", async () => {
    const log: string[] = [];
    await probeTransitions(stuckGateway(new Set()), switches(21), { onProgress: (e) => log.push(e) });
    expect(log).toEqual(["probeInteractions — 10 of 21 safe elements tried", "probeInteractions — 20 of 21 safe elements tried"]);
  });
});
