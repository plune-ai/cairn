import { describe, it, expect } from "vitest";
import { classifyBrowserError, navigateWithRecovery, type NavOps } from "../../src/browser/recovery.js";

describe("classifyBrowserError (#90 — transient vs fatal ladder)", () => {
  it("classifies transient SPA / network navigation errors", () => {
    for (const m of [
      "net::ERR_ABORTED at https://app/x",
      "net::ERR_NETWORK_CHANGED",
      "net::ERR_CONNECTION_RESET",
      "Timeout 30000ms exceeded",
      "Execution context was destroyed, most likely because of a navigation",
      "frame was detached",
    ]) {
      expect(classifyBrowserError(new Error(m)), m).toBe("transient");
    }
  });

  it("classifies DNS / refused / cert / missing-binary / unknown as fatal", () => {
    for (const m of [
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_CERT_DATE_INVALID",
      "Executable doesn't exist at /ms-playwright/chromium",
      "totally unrecognised explosion",
    ]) {
      expect(classifyBrowserError(new Error(m)), m).toBe("fatal");
    }
  });

  it("treats a non-Error throw safely (stringifies)", () => {
    expect(classifyBrowserError("net::ERR_ABORTED")).toBe("transient");
    expect(classifyBrowserError(null)).toBe("fatal");
  });
});

/** A fake NavOps with call counters; `gotoResults[i]` drives the i-th goto ("ok" or an error message). */
function makeOps(gotoResults: Array<"ok" | string>) {
  const spy = { gotos: 0, settles: 0, recreates: 0 };
  const ops: NavOps = {
    goto: async () => {
      const r = gotoResults[spy.gotos] ?? "ok";
      spy.gotos += 1;
      if (r !== "ok") throw new Error(r);
    },
    settle: async () => {
      spy.settles += 1;
    },
    recreate: async () => {
      spy.recreates += 1;
    },
  };
  return { ops, spy };
}

describe("navigateWithRecovery (#90 — tiered recovery ladder)", () => {
  it("success on first goto: no settle, no recovery", async () => {
    const { ops, spy } = makeOps(["ok"]);
    await navigateWithRecovery(ops);
    expect(spy).toEqual({ gotos: 1, settles: 0, recreates: 0 });
  });

  it("transient error → wait+retry on the SAME page (no recreate ⇒ grounded state kept)", async () => {
    const { ops, spy } = makeOps(["net::ERR_ABORTED", "ok"]);
    await navigateWithRecovery(ops);
    expect(spy.gotos).toBe(2);
    expect(spy.settles).toBe(1);
    expect(spy.recreates).toBe(0); // the key DoD invariant: transient must NOT trigger recovery
  });

  it("only a fatal error triggers the expensive recovery (recreate)", async () => {
    const { ops, spy } = makeOps(["net::ERR_NAME_NOT_RESOLVED", "ok"]);
    await navigateWithRecovery(ops);
    expect(spy.settles).toBe(0); // fatal does not waste a transient retry
    expect(spy.recreates).toBe(1); // recovery WAS triggered
    expect(spy.gotos).toBe(2); // one retry after recreate
  });

  it("a persistent fatal error recovers once, then propagates", async () => {
    const { ops, spy } = makeOps(["net::ERR_NAME_NOT_RESOLVED", "net::ERR_NAME_NOT_RESOLVED"]);
    await expect(navigateWithRecovery(ops)).rejects.toThrow(/NAME_NOT_RESOLVED/);
    expect(spy.recreates).toBe(1);
    expect(spy.gotos).toBe(2);
  });

  it("exhausting transient retries escalates to recovery (default retries = 2)", async () => {
    const { ops, spy } = makeOps(["net::ERR_ABORTED", "net::ERR_ABORTED", "net::ERR_ABORTED", "ok"]);
    await navigateWithRecovery(ops);
    expect(spy.settles).toBe(2); // two same-page retries
    expect(spy.recreates).toBe(1); // then escalate
    expect(spy.gotos).toBe(4); // 3 transient + 1 after recreate
  });

  it("respects a custom retries count", async () => {
    const { ops, spy } = makeOps(["net::ERR_ABORTED", "ok"]);
    await navigateWithRecovery(ops, { retries: 0 }); // no transient retries → straight to recovery
    expect(spy.settles).toBe(0);
    expect(spy.recreates).toBe(1);
  });
});
