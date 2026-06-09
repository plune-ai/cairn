import { describe, it, expect } from "vitest";
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
