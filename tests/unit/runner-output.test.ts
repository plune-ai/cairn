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

  it("on CI the report's metadata holds the pull request's title and diff: their words are no missing browser", () => {
    const report = JSON.stringify({
      config: { metadata: { ci: { prTitle: "chore: npx playwright install in the workflow" }, gitDiff: MISSING_BROWSER_STDERR } },
      ...JSON.parse(REPORTER_JSON),
      errors: [],
    });
    expect(resultsFromRunnerOutput(report, "")).toEqual([
      { title: "loads", status: "passed" },
      { title: "submits", status: "failed" },
    ]);
  });

  it("a browser really missing still throws, said by a test's error, the report's own errors or text before the report", () => {
    const failed = { suites: [{ specs: [{ title: "t", tests: [{ results: [{ status: "failed", error: { message: MISSING_BROWSER_STDERR } }] }] }] }] };
    expect(() => resultsFromRunnerOutput(JSON.stringify(failed), "")).toThrow(/cairn install-browsers/);
    expect(() => resultsFromRunnerOutput(JSON.stringify({ errors: [{ message: MISSING_BROWSER_STDERR }], suites: [] }), "")).toThrow(/cairn install-browsers/);
    expect(() => resultsFromRunnerOutput(`${MISSING_BROWSER_STDERR}\n${REPORTER_JSON}`, "")).toThrow(/cairn install-browsers/);
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

  it("#252: a test's error that quotes the page is no missing browser, whatever the page says", () => {
    // An assertion on the title of a docs page about installing browsers, every browser in place.
    const message = 'Error: expect(page).toHaveTitle(expected) failed\n\nExpected: "Sign in"\nReceived: "playwright install | Docs"';
    const json = JSON.stringify({ suites: [{ specs: [{ title: "docs", tests: [{ results: [{ status: "failed", error: { message } }] }] }] }] });
    expect(resultsFromRunnerOutput(json, "")).toEqual([{ title: "docs", status: "failed", error: message }]);
    // the page may even quote the launch error itself: only an error that starts with it is one
    const quoted = `Error: expect(locator).toHaveText(expected) failed\n\nReceived: "${MISSING_BROWSER_STDERR}"`;
    const json2 = JSON.stringify({ suites: [{ specs: [{ title: "faq", tests: [{ results: [{ status: "failed", error: { message: quoted } }] }] }] }] });
    expect(resultsFromRunnerOutput(json2, "")).toHaveLength(1);
  });

  it("#252: every project and every retry is read: a browser missing in the second one still throws", () => {
    const launch = { status: "failed", error: { message: MISSING_BROWSER_STDERR } };
    const passed = { status: "passed" };
    const retried = { suites: [{ specs: [{ title: "t", tests: [{ results: [{ status: "failed", error: { message: "Error: flaked" } }, launch] }] }] }] };
    const projects = { suites: [{ specs: [{ title: "t", tests: [{ projectName: "a", results: [passed] }, { projectName: "b", results: [launch] }] }] }] };
    expect(() => resultsFromRunnerOutput(JSON.stringify(retried), "")).toThrow(/cairn install-browsers/);
    expect(() => resultsFromRunnerOutput(JSON.stringify(projects), "")).toThrow(/cairn install-browsers/);
  });

  it("#252: a test per project, named by it; its status is its last attempt's, its errors every attempt's", () => {
    const json = {
      suites: [
        {
          specs: [
            {
              title: "t",
              tests: [
                { projectName: "desktop", results: [{ status: "failed", error: { message: "Error: first try" } }, { status: "passed" }] },
                { projectName: "mobile", results: [{ status: "failed", error: { message: "Error: too narrow" } }] },
              ],
            },
          ],
        },
      ],
    };
    expect(resultsFromRunnerOutput(JSON.stringify(json), "")).toEqual([
      { title: "t [desktop]", status: "passed", error: "Error: first try" },
      { title: "t [mobile]", status: "failed", error: "Error: too narrow" },
    ]);
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

  describe("a request's call log holds the full URL and every header: it stays out (#250)", () => {
    const SECRET = "S3CRET-q7";
    const requestLog =
      `Call log:\n\u001b[2m  - → POST http://127.0.0.1:1/api/${SECRET}?k=${SECRET}\u001b[22m\n` +
      `\u001b[2m    - Authorization: Bearer ${SECRET}\u001b[22m\n\u001b[2m    - content-length: 18\u001b[22m\n`;

    it("a request that got no answer keeps its first line", () => {
      // As Playwright 1.61 writes it.
      const failed = `Error: apiRequestContext.fetch: connect ECONNREFUSED 127.0.0.1:1\n${requestLog}`;
      const [r] = resultsFromRunnerOutput(reporterJson("failed", failed, [`${failed}\n   at x.spec.ts:5\n\n  4 | y\n`]), "");
      expect(r!.error).toBe("Error: apiRequestContext.fetch: connect ECONNREFUSED 127.0.0.1:1");
    });

    const dim = (line: string): string => `\u001b[2m${line}\u001b[22m\n`;
    /** expect(response).toBeOK(), as Playwright 1.61 writes it: no `- ` before the log's lines. */
    const notOk = (status: string, more = ""): string =>
      "Error: \u001b[2mexpect(\u001b[22m\u001b[31mresponse\u001b[39m\u001b[2m).\u001b[22mtoBeOK\u001b[2m(\u001b[22m\u001b[2m)\u001b[22m failed\n\n\nCall log:\n" +
      dim(`→ GET http://127.0.0.1:57622/denied/${SECRET}`) +
      dim(`  Authorization: Bearer ${SECRET}`) +
      more +
      dim(status) +
      dim("  content-type: text/plain") +
      dim(`  set-cookie: sid=${SECRET}`) +
      "\nResponse text:\n\u001b[2mno access\u001b[22m";
    const opening = "Error: \u001b[2mexpect(\u001b[22m\u001b[31mresponse\u001b[39m\u001b[2m).\u001b[22mtoBeOK\u001b[2m(\u001b[22m\u001b[2m)\u001b[22m failed\n\n\n";
    const closing = "\n\nResponse text:\n\u001b[2mno access\u001b[22m";

    it("expect(response).toBeOK() keeps the status and what it says around the log, not the URL or a header", () => {
      const [r] = resultsFromRunnerOutput(reporterJson("failed", notOk("← 401 Unauthorized"), []), "");
      expect(r!.error).toBe(`${opening}← 401 Unauthorized${closing}`);
    });

    it("a redirect it followed keeps each status, and no Location", () => {
      const hop = dim("← 302 Found") + dim(`  location: /denied?k=${SECRET}`) + dim(`→ GET http://127.0.0.1:57622/denied?k=${SECRET}`) + dim(`  cookie: sid=${SECRET}`);
      const [r] = resultsFromRunnerOutput(reporterJson("failed", notOk("← 401 Unauthorized", hop), []), "");
      expect(r!.error).toBe(`${opening}← 302 Found\n← 401 Unauthorized${closing}`);
    });

    it.each([
      ["with a reason that is not plain words", `← 401 sid=${SECRET}`],
      ["with no reason", "← 401"],
    ])("a status %s keeps the code alone: the server wrote the reason", (_label, status) => {
      const [r] = resultsFromRunnerOutput(reporterJson("failed", notOk(status), []), "");
      expect(r!.error).toBe(`${opening}← 401${closing}`);
    });

    /** A test that catches a failed request and repeats its text, as the runner reported each one. */
    const carried: [string, string, string][] = [
      [
        "expect(e.message).toBe('x'): a diff, with colour codes as text",
        "Error: expect(received).toBe(expected)\n\n\u001b[32m- x\u001b[39m\n\u001b[31m+ apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1\u001b[39m\n\u001b[31m+ Call log:\u001b[39m\n" +
          `\u001b[31m+ \\x1b[2m  - → GET http://127.0.0.1:1/api/${SECRET}\\x1b[22m\u001b[39m\n` +
          `\u001b[31m+ \\x1b[2m    - Authorization: Bearer ${SECRET}\\x1b[22m\u001b[39m\n\u001b[31m+\u001b[39m`,
        "Error: expect(received).toBe(expected)\n\n\u001b[32m- x\u001b[39m\n\u001b[31m+ apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1\u001b[39m\n\u001b[31m+\u001b[39m",
      ],
      [
        "expect(e.message).toContain('nope'): two colour codes before each line",
        'Error: expect(received).toContain(expected)\n\nReceived string:    \u001b[31m"apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1\u001b[39m\n\u001b[31mCall log:\u001b[39m\n' +
          `\u001b[31m\u001b[2m  - → GET http://127.0.0.1:1/api/${SECRET}\u001b[22m\u001b[39m\n` +
          `\u001b[31m\u001b[2m    - Authorization: Bearer ${SECRET}\u001b[22m\u001b[39m\n\u001b[31m"\u001b[39m`,
        'Error: expect(received).toContain(expected)\n\nReceived string:    \u001b[31m"apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1\u001b[39m\n\u001b[31m"\u001b[39m',
      ],
      [
        "the text indented",
        `Error: Failed:\n    apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1\n    Call log:\n    \u001b[2m  - → GET http://127.0.0.1:1/api/${SECRET}\u001b[22m\n    \u001b[2m    - Authorization: Bearer ${SECRET}\u001b[22m\n    `,
        "Error: Failed:\n    apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1",
      ],
      [
        "the log with its heading cut off",
        `Error: Failed:\n\n\u001b[2m  - → GET http://127.0.0.1:1/api/${SECRET}\u001b[22m\n\u001b[2m    - Authorization: Bearer ${SECRET}\u001b[22m\n`,
        "Error: Failed:",
      ],
    ];
    it.each(carried)("a test's own text keeps no request log: %s", (_label, message, kept) => {
      const [r] = resultsFromRunnerOutput(reporterJson("failed", message, []), "");
      expect(r!.error).toBe(kept);
    });

    it("an arrow that is no request log stays: in a locator's name, or in a test's own words", () => {
      const message = "Error: locator.click: Timeout 2000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: '→ GET it' })\u001b[22m\n\nExpected: → Next step\n← Back";
      const [r] = resultsFromRunnerOutput(reporterJson("failed", message, []), "");
      expect(r!.error).toBe(message);
    });

    it("a locator's call log stays: it names the locator, and what the failure was", () => {
      const message = "Error: locator.click: Timeout 2000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Save' })\u001b[22m\n\u001b[2m  - <div></div> intercepts pointer events\u001b[22m\n";
      const [r] = resultsFromRunnerOutput(reporterJson("failed", message, []), "");
      expect(r!.error).toBe(message.trim());
    });
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

  it("a failure inside a helper file reads as before too: its frame opens with `at helpers.ts:5`, no column", () => {
    const strict = "Error: locator.click: Error: strict mode violation: getByRole('link') resolved to 2 elements:\n\nCall log:\n  - waiting for getByRole('link')\n";
    const formatted =
      `${strict}\n\n   at helpers.ts:5\n\n  4 | export async function openFirstLink(page: Page): Promise<void> {\n` +
      `> 5 |   await page.getByRole("link").click();\n    |                                ^\n  6 | }\n` +
      `    at openFirstLink (C:\\Users\\alice\\shop\\tests\\helpers.ts:5:32)\n    at C:\\Users\\alice\\shop\\tests\\login.spec.ts:24:9`;
    const [r] = resultsFromRunnerOutput(reporterJson("failed", strict, [formatted]), "");
    expect(r!.error).toBe(strict.trim());
  });

  it("a hostile error text costs linear time — no backtracking on a run of newlines or spaces", () => {
    const hostile = ["x\n" + " ".repeat(80_000) + "x", "x\n  at " + "a:".repeat(40_000), "→ GET x\n" + "-".repeat(80_000) + "x", "→ GET x\n" + "a".repeat(80_000), "→ GET x\n" + " ".repeat(80_000) + "→"];
    // The newlines escalate. A cubic pattern fails on 5 000 within seconds, before 50 000 could run for hours. A
    // quadratic one (a single `\s*`) passes 5 000 in 10 ms and fails on 50 000 at about a second.
    for (const newlines of [5_000, 50_000]) {
      const t0 = performance.now();
      resultsFromRunnerOutput(reporterJson("failed", "boom", ["x" + "\n".repeat(newlines) + "x", ...hostile]), "");
      expect(performance.now() - t0).toBeLessThan(200); // the cubic form took 1.2 s for 2 000 newlines
    }
  });
});
