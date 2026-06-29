import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import {
  configContent,
  screencastsFromRunnerOutput,
  screencastsFromJson,
} from "../../src/validate/runner.js";

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
});

describe("#94 screencastsFromJson — .webm + step chapters", () => {
  it("registers the .webm (relative to runDir) and maps chapters to scenario steps", () => {
    const entries = screencastsFromJson(JSON.parse(RECORDED_JSON), "/runs/abc");
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.test).toBe("login flow");
    // path is stored relative to the run dir so the artifact travels with it
    expect(e.video).toBe(["screencasts", "login", "video.webm"].join(sep));
    // hook steps are dropped from chapters; the two scenario steps remain, in order
    expect(e.chapters.map((c) => c.title)).toEqual(["Navigate to login", "Submit credentials"]);
  });

  it("offsets are cumulative and hook duration still advances the clock (timecodes stay aligned)", () => {
    const e = screencastsFromJson(JSON.parse(RECORDED_JSON), "/runs/abc")[0]!;
    // 'Navigate' starts after the 500ms Before-Hooks; 'Submit' after Before-Hooks + Navigate (1200ms).
    expect(e.chapters[0]!.atMs).toBe(500);
    expect(e.chapters[1]!.atMs).toBe(500 + 1200);
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
