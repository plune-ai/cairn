import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isMissingBrowserError, missingBrowsersError } from "../browser/preflight.js";
import { stepsFromTrace } from "./trace-chapters.js";
import { installWriteGuard } from "./write-guard.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
/** Run via `node <playwright>/cli.js test` — cross-platform, without npx/.cmd. */
const PW_CLI = join(dirname(require.resolve("playwright/package.json")), "cli.js");
/** Absolute path to @playwright/test — so the config resolves it from any runDir folder. */
const PW_TEST = require.resolve("@playwright/test");

export type TestStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
export interface RawTestResult {
  title: string;
  status: TestStatus;
  /** Playwright's failure message (assertion/strict-mode/timeout) — fed into the repair hint so codegen can fix the CAUSE. */
  error?: string;
}

/** Names of the environment variables that hold Basic Auth (never the values). */
export interface HttpCredentialsEnv {
  usernameVar: string;
  passwordVar: string;
}

/**
 * #256: where Playwright writes a run's files. Always inside the run: without it Playwright uses `test-results/` beside
 * the nearest `package.json`, the user's project, which every run then shares and clears.
 */
function outputDirOf(runDir: string, screencastDir?: string): string {
  return screencastDir ?? join(runDir, "test-results");
}

export function configContent(
  runDir: string,
  storageStatePath?: string,
  channel?: string,
  workers = 5,
  screencastDir?: string,
  httpCredentialsEnv?: HttpCredentialsEnv,
  secretsInRun = false,
  guardTsconfig?: string,
): string {
  const launchOpts = `launchOptions: { args: ['--disable-blink-features=AutomationControlled'] }`;
  const parts = ["headless: true"];
  if (storageStatePath) parts.push(`storageState: ${JSON.stringify(storageStatePath)}`);
  // FIX B (0.3.3): when a channel is set, the runner drives the SYSTEM browser (chrome/msedge) —
  // no bundled Chromium needed, so cairn works inside projects that already have their own Playwright.
  if (channel) parts.push(`channel: ${JSON.stringify(channel)}`);
  // #94 (BORROW-05): opt-in per-scenario screencast — Playwright's built-in video. One .webm per test,
  // landing under <screencastDir> (the JSON reporter then carries the path + steps → chapter sidecar).
  // #210: a trace beside each video - its steps and frames give the chapters their exact offsets (#214).
  // Playwright writes the context options (Basic Auth in the clear), every request's headers and cookies and every
  // typed value into it, so a run with a session, Basic Auth, environment secrets, a mailbox or API flows keeps the video alone.
  if (screencastDir) parts.push(`video: 'on'`);
  if (screencastDir && !storageStatePath && !httpCredentialsEnv && !secretsInRun) parts.push(`trace: 'on'`);
  // Basic Auth: the generated config only NAMES the variables; the runner process reads the values from its own
  // environment, so no secret is ever written to disk.
  if (httpCredentialsEnv) {
    const read = (name: string): string => `process.env[${JSON.stringify(name)}] ?? ''`;
    parts.push(
      `httpCredentials: { username: ${read(httpCredentialsEnv.usernameVar)}, password: ${read(httpCredentialsEnv.passwordVar)} }`,
    );
  }
  parts.push(launchOpts);
  const use = `{ ${parts.join(", ")} }`;
  return `const { defineConfig } = require(${JSON.stringify(PW_TEST)});
module.exports = defineConfig({
  testDir: ${JSON.stringify(join(runDir, "tests"))},${guardTsconfig ? `
  tsconfig: ${JSON.stringify(guardTsconfig)},` : ""}
  fullyParallel: true,
  workers: ${workers},
  retries: 0,
  reporter: 'json',
  outputDir: ${JSON.stringify(outputDirOf(runDir, screencastDir))},
  use: ${use},
});
`;
}

export interface RunSpecsOptions {
  /** storageState file for authenticated runs (use.storageState). */
  storageStatePath?: string;
  /** Browser channel (chrome/msedge) → drive the system browser instead of the bundled Chromium. */
  channel?: string;
  /** Parallel Playwright workers (default 5; from cfg.playwrightWorkers / PLAYWRIGHT_WORKERS). */
  workers?: number;
  /**
   * #94 (BORROW-05): when set, record a `.webm` per test into this dir (Playwright video) and write a
   * step-chapter sidecar (`<dir>/screencasts.json`) for the review gate. Opt-in; off when undefined.
   */
  screencastDir?: string;
  /** Basic Auth for the generated suite: variable NAMES; the runner reads the values from process.env. */
  httpCredentialsEnv?: HttpCredentialsEnv;
  /** The suite types environment or mailbox secrets: no trace is recorded, since it would keep them (#210). */
  secretsInRun?: boolean;
  /** #285: send the suite's writes to the target. Off: the write guard blocks them (see write-guard.ts). */
  allowWrites?: boolean;
  /** #285: the origins the guard keeps writes from (the target's, the API's); none given: every origin. */
  guardOrigins?: string[];
  /** #285: called once per request the guard blocked, `METHOD url`. */
  onBlockedWrite?: (request: string) => void;
}

/** #94: one chapter marker — a scenario step title at its offset (ms) from the start of the `.webm`. */
export interface ScreencastChapter {
  title: string;
  atMs: number;
}
/** #94: a recorded scenario screencast — the `.webm` (relative to runDir) + its step chapters. */
export interface ScreencastEntry {
  test: string;
  /** Path to the `.webm`, relative to runDir (the artifact travels with the run dir), with `/` on any OS (#214). */
  video: string;
  /** #210: the Playwright trace of the same test, relative to runDir with `/`; absent when none was written. */
  trace?: string;
  /**
   * #214: where the chapter offsets come from. `trace` — the steps' start times against the video's first frame;
   * `estimated` — the sum of the step durations before each, which runs late by the hooks' time before the first frame.
   * Absent in a `screencasts.json` written before it existed: read that as `estimated`.
   */
  timing?: "trace" | "estimated";
  chapters: ScreencastChapter[];
}

interface PwAttachment {
  name?: string;
  path?: string;
  contentType?: string;
}
interface PwStep {
  title?: string;
  duration?: number;
}
interface PwResult {
  status?: string;
  error?: { message?: string };
  errors?: { message?: string }[];
  steps?: PwStep[];
  attachments?: PwAttachment[];
}
interface PwSpec {
  title: string;
  tests?: { projectName?: string; results?: PwResult[] }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwJson {
  suites?: PwSuite[];
  /** What failed outside any test: a config that did not load, a crash in a global hook. */
  errors?: { message?: string }[];
}

/** Playwright's two fixed top-level hook step titles — kept out of the reviewer's chapter list. */
const HOOK_STEP_TITLES = new Set(["Before Hooks", "After Hooks"]);

/**
 * #94: build the screencast index from the JSON reporter output. For each spec's first result, pair its
 * `video` attachment with chapter markers from `steps`. The JSON reporter omits per-step startTime, so the
 * offset is the cumulative duration of preceding top-level steps — hook steps advance the clock but are
 * dropped from the visible chapters (they aren't scenario steps). Pure (no IO) so it unit-tests cleanly.
 */
export function screencastsFromJson(json: PwJson, runDir: string): ScreencastEntry[] {
  const out: ScreencastEntry[] = [];
  const walk = (s: PwSuite): void => {
    for (const spec of s.specs ?? []) {
      const result = spec.tests?.[0]?.results?.[0];
      const videoPath = result?.attachments?.find((a) => a.name === "video" && a.path)?.path;
      if (!videoPath) continue; // no recording for this test → nothing to link
      const tracePath = result?.attachments?.find((a) => a.name === "trace" && a.path)?.path;
      const chapters: ScreencastChapter[] = [];
      let atMs = 0;
      for (const step of result?.steps ?? []) {
        if (!HOOK_STEP_TITLES.has(step.title ?? "")) {
          chapters.push({ title: step.title ?? "(step)", atMs });
        }
        atMs += step.duration ?? 0; // hooks still advance the clock so offsets stay aligned to the video
      }
      const fromRun = (p: string): string => relative(runDir, p).split(sep).join("/");
      out.push({ test: spec.title, video: fromRun(videoPath), ...(tracePath ? { trace: fromRun(tracePath) } : {}), timing: "estimated", chapters });
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of json.suites ?? []) walk(s);
  return out;
}

/** #94: parse the reporter stdout into screencast entries (empty on no/garbled JSON). Pure. */
export function screencastsFromRunnerOutput(stdout: string, runDir: string): ScreencastEntry[] {
  const start = stdout.indexOf("{");
  if (start < 0) return [];
  try {
    return screencastsFromJson(JSON.parse(stdout.slice(start)) as PwJson, runDir);
  } catch {
    return [];
  }
}

/**
 * #214: each entry with a trace takes its chapter offsets from it. The titles and their order stay the reporter's; the
 * trace's times replace the estimate only when its top-level steps are the same list, so a mismatch keeps `estimated`.
 * A trace that cannot be read keeps the estimate too: the chapters are a review aid and never fail the run.
 */
export async function withTraceTiming(entries: ScreencastEntry[], runDir: string): Promise<ScreencastEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.trace === undefined) return entry;
      try {
        const steps = stepsFromTrace(await readFile(join(runDir, entry.trace)));
        const same = steps !== undefined && steps.length === entry.chapters.length && steps.every((s, i) => s.title === entry.chapters[i]!.title);
        return same ? { ...entry, timing: "trace" as const, chapters: steps } : entry;
      } catch {
        return entry;
      }
    }),
  );
}

/**
 * The first code-frame line (`  8 |`, `> 8 |`) or stack line (`at …:8:54`, and a helper file's `at helpers.ts:5`) of
 * a formatted error. Only `[ \t]`, never `\s`, after the newline: two `\s*` runs share a run of newlines and
 * backtrack cubically (2 000 newlines took over a second).
 */
const FRAME = /\n[ \t]*(?:>[ \t]*)?(?:\d+ \||at .+:\d+(?::\d+)?\)?$)/m;

/**
 * An error without its code frame and stack. They carry the spec's absolute path, and with it the machine's user
 * name, which must not reach an LLM or a report; their line numbers would also make one failure look new after
 * every regeneration.
 */
function withoutFrame(message: string | undefined): string | undefined {
  return message?.split(FRAME)[0]?.trim();
}

/** A colour code, real or as a test's own text printed it (`\x1b[2m` inside a diff). */
const COLOUR = /(?:\u001b|\\x1b|\\u001b)\[[0-9;]*m/g;
/** What may stand before a line of a call log: Playwright's `- `, a diff's `+ `, an indent, a test's own quote. */
const LINE_PREFIX = /^[\s+\-|>"]*/;
/** A line as written, without colour codes and that prefix. */
const lineText = (line: string): string => line.replace(COLOUR, "").replace(LINE_PREFIX, "").trimEnd();

const REQUEST_SENT = /^→ [A-Z]+ /;
const REQUEST_ANSWERED = /^← (\d{3})(?: (.*))?$/;
/** A header in a request's log. Only right after `→` or `←`: elsewhere `name: value` is just text. */
const LOGGED_HEADER = /^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+:(?: |$)/;
/** A status's reason as a server may write it: the server chooses this text, so anything else is left out. */
const PLAIN_REASON = /^[A-Za-z][A-Za-z '-]{0,60}$/;

/**
 * #250: an error without a request's log. Playwright writes `→ POST <url>` and `← 401 Unauthorized`, each with its
 * headers, into the error of a failed request and of `expect(response).toBeOK()`; they hold tokens and cookies, which
 * must not reach an LLM or a report. Of the log only each status stays, which is what repair needs to know. The lines
 * are found by what they are, wherever they stand: a test may carry the text on in a diff, indented, or cut from its
 * heading. On a single line (`JSON.stringify(e.message)`) they are not found. A locator's call log stays whole: it
 * names the locator that failed and what stopped it.
 */
function withoutRequestLog(message: string | undefined): string | undefined {
  if (!message?.includes("→") && !message?.includes("←")) return message;
  const kept: string[] = [];
  let inRequestLog = false;
  for (const line of message.split("\n")) {
    const text = lineText(line);
    const answered = REQUEST_ANSWERED.exec(text);
    if (answered || REQUEST_SENT.test(text)) {
      if (lineText(kept.at(-1) ?? "") === "Call log:") kept.pop();
      if (answered) kept.push(`← ${answered[1]}${PLAIN_REASON.test(answered[2] ?? "") ? ` ${answered[2]}` : ""}`);
      inRequestLog = true;
    } else if (!inRequestLog || !LOGGED_HEADER.test(text)) {
      inRequestLog = false;
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

/**
 * #256: Playwright writes each failed test's error into `error-context.md` in the output folder, a failed request's
 * log included, and no option turns that off. The file keeps the rest (the page snapshot, the test source) and loses
 * the log by the same rule as the report. A file that cannot be rewritten is removed rather than left whole.
 */
async function scrubErrorContexts(outputDir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(outputDir, { recursive: true });
  } catch {
    return; // nothing was written
  }
  for (const file of files.filter((f) => basename(f) === "error-context.md")) {
    const path = join(outputDir, file);
    try {
      const text = await readFile(path, "utf8");
      const clean = withoutRequestLog(text);
      if (clean !== text) await writeFile(path, `${clean}\n`, "utf8");
    } catch {
      await rm(path, { force: true });
    }
  }
}

function extract(json: PwJson): RawTestResult[] {
  const out: RawTestResult[] = [];
  const walk = (s: PwSuite): void => {
    for (const spec of s.specs ?? []) {
      // #252: every test of the spec (one per project) and every attempt of it (retries), not only the first of each.
      // The status is the last attempt's, which is the one Playwright counts; the errors are every attempt's.
      const tests = spec.tests?.length ? spec.tests : [{}];
      for (const test of tests) {
        const results = test.results ?? [];
        const status = (results.at(-1)?.status ?? "failed") as TestStatus;
        // Every error, once each: on a test timeout `error` is the timeout alone, and the action's own error — the call
        // log that names the locator — is a later entry of `errors`. Those entries come formatted (message, code
        // frame, `at <absolute path>`); without the frame, `errors[0]` is `error` again.
        const messages = results
          .flatMap((r) => [r.error?.message, ...(r.errors ?? []).map((e) => e.message)])
          .map((m) => withoutRequestLog(withoutFrame(m)));
        const error = [...new Set(messages.filter(Boolean))].join("\n\n");
        const title = tests.length > 1 && test.projectName ? `${spec.title} [${test.projectName}]` : spec.title;
        out.push({ title, status, ...(error ? { error } : {}) });
      }
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of json.suites ?? []) walk(s);
  return out;
}

/**
 * Run the generated suite (runDir/tests) through the playwright test runner and return
 * a per-test result. The JSON reporter writes to stdout; a non-zero exit code (there are failures) is not an error.
 */
export async function runSpecs(runDir: string, opts: RunSpecsOptions = {}): Promise<RawTestResult[]> {
  const absRunDir = resolve(runDir); // testDir in the config must be absolute
  const configPath = join(absRunDir, "playwright.config.cjs");
  const screencastDir = opts.screencastDir ? resolve(opts.screencastDir) : undefined;
  const guard = opts.allowWrites ? undefined : await installWriteGuard(absRunDir, opts.guardOrigins ?? [], PW_TEST);
  await writeFile(
    configPath,
    configContent(absRunDir, opts.storageStatePath, opts.channel, opts.workers, screencastDir, opts.httpCredentialsEnv, opts.secretsInRun, guard?.tsconfig),
    "utf8",
  );

  // Do not inherit the parent runner's NODE_OPTIONS (vitest/tsx loader) — otherwise the child
  // playwright process tries to apply a foreign loader and crashes.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  delete childEnv.NODE_OPTIONS;

  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileAsync(process.execPath, [PW_CLI, "test", `--config=${configPath}`], {
      maxBuffer: 64 * 1024 * 1024,
      env: childEnv,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    // A non-zero exit (there ARE failing tests) is normal — keep the reporter output. But ALSO keep
    // stderr: a missing-browser death writes its cause there, and dropping it is exactly what made
    // the runner report a misleading "0% green" with no reason (the onboarding bug we're fixing).
    const err = e as { stdout?: string; stderr?: string };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  await scrubErrorContexts(outputDirOf(absRunDir, screencastDir));
  for (const request of (await guard?.blocked()) ?? []) opts.onBlockedWrite?.(request);

  // #94: when recording, drop the step-chapter sidecar next to the .webm files. The reporter writes the
  // video paths into stdout AFTER the run, so this runs post-parse. Best-effort: a recorder/IO failure
  // logs nothing-fatal and never sinks the run (the tests still ran — only the review affordance is lost).
  if (screencastDir) {
    try {
      const entries = await withTraceTiming(screencastsFromRunnerOutput(stdout, absRunDir), absRunDir);
      await writeFile(join(screencastDir, "screencasts.json"), JSON.stringify(entries, null, 2), "utf8");
    } catch {
      // screencast is an optional review affordance — never fail the run over it
    }
  }

  return resultsFromRunnerOutput(stdout, stderr);
}

/**
 * #252: a test's error says a browser is missing only when it is the launch's own error, at the start of one of its
 * errors. Elsewhere in it the words can be the page's: an assertion quotes what it found, and a page titled
 * «playwright install | Docs» said them with every browser in place.
 */
const LAUNCH_FAILED = /(?:^|\n\n)(?:Error: )?(?:browserType\.\w+: )?(?:Executable doesn't exist at|Chromium distribution '[^']*' is not found)/;

/**
 * Turn the runner's stdout/stderr into per-test results — or, when the output shows the browser
 * binary was missing, throw ONE actionable error instead of silently reporting every test "failed".
 * Pure (no process/IO) so the failure-surfacing logic is unit-tested without spawning a runner.
 */
export function resultsFromRunnerOutput(stdout: string, stderr: string): RawTestResult[] {
  const start = stdout.indexOf("{");
  let report: PwJson | undefined;
  try {
    report = start < 0 ? undefined : (JSON.parse(stdout.slice(start)) as PwJson);
  } catch {
    report = undefined;
  }
  const results = report ? extract(report) : [];
  // A report is read for what the run said, not whole: on CI its metadata holds the pull request's title and diff,
  // and those may well say "playwright install" with every browser in place.
  const said = report ? [stdout.slice(0, start), ...(report.errors ?? []).map((e) => e.message)].join("\n") : stdout;
  if (isMissingBrowserError(stderr) || isMissingBrowserError(said) || results.some((r) => LAUNCH_FAILED.test(r.error ?? ""))) {
    throw missingBrowsersError("Playwright could not launch a browser to run the generated tests.");
  }
  return results;
}
