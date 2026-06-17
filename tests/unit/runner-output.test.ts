import { describe, it, expect } from "vitest";
import { resultsFromRunnerOutput } from "../../src/validate/runner.js";

// Minimal Playwright JSON-reporter shape (one passed + one failed spec).
const REPORTER_JSON = JSON.stringify({
  suites: [
    {
      specs: [
        { title: "loads", tests: [{ results: [{ status: "passed" }] }] },
        { title: "submits", tests: [{ results: [{ status: "failed" }] }] },
      ],
    },
  ],
});

const MISSING_BROWSER_STDERR =
  "Error: browserType.launch: Executable doesn't exist at " +
  "C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1228\\chrome-headless-shell.exe\n" +
  "Please run the following command to download new browsers:\n    npx playwright install";

describe("resultsFromRunnerOutput — surfaces a missing browser instead of a fake 0% green", () => {
  it("throws an actionable error when the browser binary is missing (cause is in stderr)", () => {
    // Even if the JSON reporter still emitted 'all failed', the real cause wins.
    expect(() => resultsFromRunnerOutput(REPORTER_JSON, MISSING_BROWSER_STDERR)).toThrow(
      /npx playwright install chromium/,
    );
  });

  it("also catches the cause when Playwright printed it to stdout", () => {
    expect(() => resultsFromRunnerOutput(MISSING_BROWSER_STDERR, "")).toThrow(/playwright install/);
  });

  it("parses real pass/fail results when the run actually executed (non-zero exit is normal)", () => {
    const out = resultsFromRunnerOutput(REPORTER_JSON, "");
    expect(out).toEqual([
      { title: "loads", status: "passed" },
      { title: "submits", status: "failed" },
    ]);
  });

  it("returns [] when there is no JSON and no missing-browser signature", () => {
    expect(resultsFromRunnerOutput("", "")).toEqual([]);
    expect(resultsFromRunnerOutput("some noise without json", "warning: slow test")).toEqual([]);
  });
});
