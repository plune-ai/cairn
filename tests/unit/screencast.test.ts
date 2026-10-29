import { describe, it, expect } from "vitest";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configContent,
  screencastsFromRunnerOutput,
  screencastsFromJson,
  withTraceTiming,
  type ScreencastEntry,
} from "../../src/validate/runner.js";
import { stepsFromTrace } from "../../src/validate/trace-chapters.js";
import { readFileSync } from "node:fs";

/** #214: the first scenario of a worker - its first step 2 211 ms before the video's first frame (see the fixture's builder note). */
const FIRST_IN_WORKER = join(import.meta.dirname, "../fixtures/trace/first-in-worker.zip");

// A Playwright JSON-reporter result with a recorded video + step timeline. The top-level steps include
// the two fixed hook steps (which advance the clock but are NOT scenario chapters) plus two test.step()s.
const RECORDED_JSON = JSON.stringify({
  suites: [
    {
      specs: [
        {
          title: "login flow",
          tests: [
            {
              results: [
                {
                  status: "passed",
                  steps: [
                    { title: "Before Hooks", duration: 500 },
                    { title: "Navigate to login", duration: 1200 },
                    { title: "Submit credentials", duration: 800 },
                    { title: "After Hooks", duration: 100 },
                  ],
                  attachments: [
                    { name: "video", contentType: "video/webm", path: "/runs/abc/screencasts/login/video.webm" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("#94 configContent — opt-in screencast recording", () => {
  it("default (no screencastDir): no video, no outputDir — zero regression", () => {
    const cfg = configContent("/runs/x");
    expect(cfg).not.toMatch(/video:/);
    expect(cfg).not.toMatch(/outputDir:/);
  });

  it("enables Playwright video + a stable outputDir when recording is on", () => {
    const cfg = configContent("/runs/x", undefined, undefined, 5, "/runs/x/screencasts");
    expect(cfg).toMatch(/video:\s*'on'/);
    expect(cfg).toMatch(/outputDir:\s*"\/runs\/x\/screencasts"/);
  });

  it("#210: records a trace beside each video, and none without recording", () => {
    expect(configContent("/runs/x", undefined, undefined, 5, "/runs/x/screencasts")).toMatch(/trace:\s*'on'/);
    expect(configContent("/runs/x")).not.toMatch(/trace:/);
  });
});

describe("#94 screencastsFromJson — .webm + step chapters", () => {
  it("registers the .webm (relative to runDir) and maps chapters to scenario steps", () => {
    const entries = screencastsFromJson(JSON.parse(RECORDED_JSON), "/runs/abc");
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.test).toBe("login flow");
    // path is stored relative to the run dir so the artifact travels with it - in POSIX form on any OS (#214),
    // so a reader on another OS resolves it (Windows wrote `screencasts\login\video.webm`)
    expect(e.video).toBe("screencasts/login/video.webm");
    // hook steps are dropped from chapters; the two scenario steps remain, in order
    expect(e.chapters.map((c) => c.title)).toEqual(["Navigate to login", "Submit credentials"]);
  });

  it("offsets are cumulative and hook duration still advances the clock (timecodes stay aligned)", () => {
    const e = screencastsFromJson(JSON.parse(RECORDED_JSON), "/runs/abc")[0]!;
    // 'Navigate' starts after the 500ms Before-Hooks; 'Submit' after Before-Hooks + Navigate (1200ms).
    expect(e.chapters[0]!.atMs).toBe(500);
    expect(e.chapters[1]!.atMs).toBe(500 + 1200);
  });

  it("#210: keeps the trace's path relative to the run dir with /, and marks the offsets estimated until the trace is read", () => {
    const json = JSON.parse(RECORDED_JSON);
    json.suites[0].specs[0].tests[0].results[0].attachments.push({ name: "trace", contentType: "application/zip", path: "/runs/abc/screencasts/login/trace.zip" });
    const e = screencastsFromJson(json, "/runs/abc")[0]!;
    expect(e.trace).toBe("screencasts/login/trace.zip");
    expect(e.timing).toBe("estimated");
    expect(screencastsFromJson(JSON.parse(RECORDED_JSON), "/runs/abc")[0]!.trace).toBeUndefined();
  });

  it("skips a test with no video attachment (nothing to link)", () => {
    const json = {
      suites: [{ specs: [{ title: "no recording", tests: [{ results: [{ status: "passed", steps: [] }] }] }] }],
    };
    expect(screencastsFromJson(json, "/runs/abc")).toEqual([]);
  });
});

describe("#94 screencastsFromRunnerOutput — tolerant parsing (recorder failure must not crash)", () => {
  it("returns [] on garbled / empty reporter output instead of throwing", () => {
    expect(screencastsFromRunnerOutput("", "/runs/abc")).toEqual([]);
    expect(screencastsFromRunnerOutput("not json {oops", "/runs/abc")).toEqual([]);
  });

  it("parses the video + chapters out of real reporter stdout", () => {
    const out = screencastsFromRunnerOutput(`noise before json\n${RECORDED_JSON}`, "/runs/abc");
    expect(out[0]?.chapters).toHaveLength(2);
  });
});

describe("#214 chapter offsets from the trace", () => {
  it("counts from the video's first frame: steps before it sit at 0, the next one where it really is", () => {
    // The estimate put «see it added» at 2 231 ms of a 1.2 s video; the trace puts it 20 ms in.
    expect(stepsFromTrace(readFileSync(FIRST_IN_WORKER))).toEqual([
      { title: "open the shop", atMs: 0 },
      { title: "add an item", atMs: 0 },
      { title: "see it added", atMs: 20 },
    ]);
  });

  it("withTraceTiming: an entry whose trace has the same steps takes its offsets; a different list, a missing trace or none keep the estimate", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "cairn-214-"));
    try {
      await mkdir(join(runDir, "screencasts", "shop"), { recursive: true });
      await copyFile(FIRST_IN_WORKER, join(runDir, "screencasts", "shop", "trace.zip"));
      const estimated = (titles: string[], trace?: string): ScreencastEntry => ({
        test: "shop",
        video: "screencasts/shop/video.webm",
        ...(trace ? { trace } : {}),
        timing: "estimated",
        chapters: titles.map((title, i) => ({ title, atMs: 1000 * i })),
      });
      const steps = ["open the shop", "add an item", "see it added"];
      const [exact, other, gone, none] = await withTraceTiming(
        [
          estimated(steps, "screencasts/shop/trace.zip"),
          estimated(["open the shop", "pay"], "screencasts/shop/trace.zip"),
          estimated(steps, "screencasts/missing/trace.zip"),
          estimated(steps),
        ],
        runDir,
      );
      expect(exact).toMatchObject({ timing: "trace", chapters: [{ atMs: 0 }, { atMs: 0 }, { title: "see it added", atMs: 20 }] });
      for (const kept of [other, gone, none]) expect(kept!.timing).toBe("estimated");
      expect(other!.chapters.map((c) => c.atMs)).toEqual([0, 1000]);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
