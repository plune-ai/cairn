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
    // Even if the JSON reporter still emitted 'all failed', the real cause wins. The INPUT carries
    // Playwright's native "npx playwright install" banner (still detected); the OUTPUT message now
    // points at cairn's own installer + the channel escape hatch (FIX C, 0.3.3).
    expect(() => resultsFromRunnerOutput(REPORTER_JSON, MISSING_BROWSER_STDERR)).toThrow(
      /cairn install-browsers/,
    );
  });

  it("also catches the cause when Playwright printed it to stdout", () => {
    expect(() => resultsFromRunnerOutput(MISSING_BROWSER_STDERR, "")).toThrow(/cairn install-browsers/);
  });

  it("parses real pass/fail results when the run actually executed (non-zero exit is normal)", () => {
    const out = resultsFromRunnerOutput(REPORTER_JSON, "");
    expect(out).toEqual([
      { title: "loads", status: "passed" },
      { title: "submits", status: "failed" },
    ]);
  });

  it("captures the failing test's error message from the reporter JSON (for the repair hint)", () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "TC-3",
              tests: [{ results: [{ status: "failed", error: { message: "strict mode violation: resolved to 3 elements" } }] }],
            },
          ],
        },
      ],
    });
    const out = resultsFromRunnerOutput(json, "");
    expect(out[0]).toMatchObject({
      title: "TC-3",
      status: "failed",
      error: expect.stringContaining("strict mode violation"),
    });
  });

  it("returns [] when there is no JSON and no missing-browser signature", () => {
    expect(resultsFromRunnerOutput("", "")).toEqual([]);
    expect(resultsFromRunnerOutput("some noise without json", "warning: slow test")).toEqual([]);
  });

});

// Shapes captured from a Playwright 1.61 JSON report (#184): `error` is the raw first error; every `errors` entry is
// formatted — its message, a code frame, then `at <absolute path>` (here a home folder with a user name in it).
describe("resultsFromRunnerOutput — every error, once, without its code frame", () => {
  const frame = (line: number, code: string): string =>
    `\n\n\n  ${line - 1} |   await page.goto("http://127.0.0.1:5180/login.html");\n> ${line} |   ${code}\n` +
    `     |   ^\n  ${line + 1} | });\n    at C:\\Users\\alice\\shop\\tests\\login.spec.ts:${line}:20`;
  const reporterJson = (status: string, error: string, errors: string[]): string =>
    JSON.stringify({
      suites: [{ specs: [{ title: "TC-1", tests: [{ results: [{ status, error: { message: error }, errors: errors.map((message) => ({ message })) }] }] }] }],
    });

  it("a test timeout keeps the action's error too — its call log names the locator", () => {
    // A click on a locator that never appears: the test's timeout fires first and becomes `error`; the action's own
    // error, with the call log, is the second entry of `errors`.
    const timeout = "Test timeout of 30000ms exceeded.";
    const action = "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Log in' })";
    const click = `await page.getByRole("button", { name: "Log in" }).click();`;
    const [r] = resultsFromRunnerOutput(reporterJson("timedOut", timeout, [timeout, action + frame(8, click)]), "");
    expect(r!.error).toBe(`${timeout}\n\n${action}`);
  });

  it("a single failure reads exactly as before: its formatted copy in `errors` is the same error", () => {
    const strict =
      "Error: locator.click: Error: strict mode violation: getByRole('link') resolved to 2 elements:\n" +
      "    1) <a href=\"/list.html\">View list</a> aka getByRole('link', { name: 'View list' })\n" +
      "    2) <a href=\"/modal.html\">Open modal page</a> aka getByRole('link', { name: 'Open modal page' })\n\n" +
      "Call log:\n  - waiting for getByRole('link')\n";
    const [r] = resultsFromRunnerOutput(reporterJson("failed", strict, [strict + frame(13, `await page.getByRole("link").click();`)]), "");
    expect(r!.error).toBe(strict.trim());
  });

  it("no code frame or stack line leaves the runner: the absolute path carries the machine's user name", () => {
    const timeout = "Test timeout of 30000ms exceeded.";
    const thrown = "Error: boom\n    at Object.<anonymous> (C:\\Users\\alice\\shop\\tests\\login.spec.ts:3:9)";
    const [r] = resultsFromRunnerOutput(reporterJson("timedOut", timeout, [timeout, thrown]), "");
    expect(r!.error).toBe(`${timeout}\n\nError: boom`);
  });
});
