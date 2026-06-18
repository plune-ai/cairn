import { describe, it, expect, vi } from "vitest";
import { makeCliProgress } from "../../src/core/progress.js";

describe("makeCliProgress — non-TTY (pipe / CI)", () => {
  it("prints one plain line per event with no carriage-return animation", () => {
    const out: string[] = [];
    const p = makeCliProgress({ write: (s) => out.push(s), isTTY: false, now: () => 0 });
    p.event("observe — opening");
    p.event("design — thinking");
    p.stop();
    const joined = out.join("");
    expect(joined).toBe("  ▸ observe — opening\n  ▸ design — thinking\n");
    expect(joined).not.toContain("\r"); // no in-place rewrites in a pipe
  });
});

describe("makeCliProgress — TTY (in-place spinner)", () => {
  it("animates the current step in place with a growing elapsed counter", () => {
    vi.useFakeTimers();
    let t = 0;
    const out: string[] = [];
    const p = makeCliProgress({ write: (s) => out.push(s), isTTY: true, now: () => t, intervalMs: 100 });

    p.event("designTestCases — designing");
    expect(out.join("")).toContain("designTestCases — designing");

    t = 2000;
    vi.advanceTimersByTime(100); // fire one tick at elapsed = 2s
    const joined = out.join("");
    expect(joined).toContain("\r"); // in-place updates use a carriage return
    expect(joined).toContain(`${String.fromCharCode(27)}[K`); // proper ANSI erase, not a literal "[K"
    expect(joined).toContain("2s"); // elapsed counter rendered

    p.stop();
    vi.useRealTimers();
  });

  it("commits the previous step as a permanent line when a new event arrives", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = makeCliProgress({ write: (s) => out.push(s), isTTY: true, now: () => 0, intervalMs: 100 });

    p.event("observe — opening");
    p.event("design — thinking"); // observe is now done → frozen on its own line

    expect(out.join("")).toContain("  ▸ observe — opening\n");
    p.stop();
    vi.useRealTimers();
  });

  it("commits the final step and stops the timer on stop()", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = makeCliProgress({ write: (s) => out.push(s), isTTY: true, now: () => 0, intervalMs: 100 });

    p.event("design — thinking");
    p.stop();
    expect(out.join("")).toContain("  ▸ design — thinking\n");

    const writesAfterStop = out.length;
    vi.advanceTimersByTime(500); // a dangling interval would emit more frames here
    expect(out.length).toBe(writesAfterStop);
    vi.useRealTimers();
  });
});
