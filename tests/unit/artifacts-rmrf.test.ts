import { describe, it, expect } from "vitest";
import { rm } from "node:fs/promises";
import { rmrf } from "../../src/artifacts/index.js";

/** A fake `rm` driven by a script: each call consumes the next entry ("ok" or an errno code to throw). */
function makeRm(results: Array<"ok" | string>) {
  let calls = 0;
  const fn = (async () => {
    const r = results[calls] ?? "ok";
    calls += 1;
    if (r !== "ok") {
      const e = new Error(r) as NodeJS.ErrnoException;
      e.code = r;
      throw e;
    }
  }) as unknown as typeof rm;
  return { fn, calls: () => calls };
}

describe("rmrf — resilient cleanup on Windows file locks (#101)", () => {
  it("retries on EBUSY and succeeds once the lock clears", async () => {
    const { fn, calls } = makeRm(["EBUSY", "EBUSY", "ok"]);
    await expect(rmrf("d", fn, 4, 0)).resolves.toBeUndefined();
    expect(calls()).toBe(3);
  });

  it("retries on EPERM (the other Windows lock code)", async () => {
    const { fn, calls } = makeRm(["EPERM", "ok"]);
    await rmrf("d", fn, 4, 0);
    expect(calls()).toBe(2);
  });

  it("treats ENOTEMPTY (rmdir race) as transient too", async () => {
    const { fn, calls } = makeRm(["ENOTEMPTY", "ok"]);
    await rmrf("d", fn, 4, 0);
    expect(calls()).toBe(2);
  });

  it("gives up cleanly (no throw) when the lock never clears — the run is NOT rejected", async () => {
    const { fn, calls } = makeRm(Array(10).fill("EBUSY"));
    await expect(rmrf("d", fn, 4, 0)).resolves.toBeUndefined(); // graceful, best-effort
    expect(calls()).toBe(5); // 1 initial + 4 retries
  });

  it("POSIX path: the first attempt wins → a single call (behaviour unchanged)", async () => {
    const { fn, calls } = makeRm(["ok"]);
    await rmrf("d", fn, 4, 0);
    expect(calls()).toBe(1);
  });

  it("propagates a non-lock error immediately (never mask a real bug)", async () => {
    const { fn, calls } = makeRm(["EACCES"]);
    await expect(rmrf("d", fn, 4, 0)).rejects.toThrow(/EACCES/);
    expect(calls()).toBe(1); // no retry on a non-lock error
  });

  it("REGRESSION: the old bare `rm` rejected on EBUSY — which sank the whole run; rmrf absorbs it", async () => {
    const { fn } = makeRm(["EBUSY"]);
    // Pre-fix, writeSuite/writeJourneySpecs awaited a bare rm → this rejection propagated → run died.
    await expect(fn("d", { recursive: true, force: true })).rejects.toThrow(/EBUSY/);
    // Post-fix the same lock is absorbed (proven by the "gives up cleanly" case above).
  });
});
