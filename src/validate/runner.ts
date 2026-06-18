import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isMissingBrowserError, missingBrowsersError } from "../browser/preflight.js";

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
}

export function configContent(runDir: string, storageStatePath?: string, channel?: string): string {
  const launchOpts = `launchOptions: { args: ['--disable-blink-features=AutomationControlled'] }`;
  const parts = ["headless: true"];
  if (storageStatePath) parts.push(`storageState: ${JSON.stringify(storageStatePath)}`);
  // FIX B (0.3.3): when a channel is set, the runner drives the SYSTEM browser (chrome/msedge) —
  // no bundled Chromium needed, so cairn works inside projects that already have their own Playwright.
  if (channel) parts.push(`channel: ${JSON.stringify(channel)}`);
  parts.push(launchOpts);
  const use = `{ ${parts.join(", ")} }`;
  return `const { defineConfig } = require(${JSON.stringify(PW_TEST)});
module.exports = defineConfig({
  testDir: ${JSON.stringify(join(runDir, "tests"))},
  fullyParallel: true,
  retries: 0,
  reporter: 'json',
  use: ${use},
});
`;
}

export interface RunSpecsOptions {
  /** storageState file for authenticated runs (use.storageState). */
  storageStatePath?: string;
  /** Browser channel (chrome/msedge) → drive the system browser instead of the bundled Chromium. */
  channel?: string;
}

interface PwSpec {
  title: string;
  tests?: { results?: { status?: string }[] }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwJson {
  suites?: PwSuite[];
}

function extract(json: PwJson): RawTestResult[] {
  const out: RawTestResult[] = [];
  const walk = (s: PwSuite): void => {
    for (const spec of s.specs ?? []) {
      const status = (spec.tests?.[0]?.results?.[0]?.status ?? "failed") as TestStatus;
      out.push({ title: spec.title, status });
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
  await writeFile(configPath, configContent(absRunDir, opts.storageStatePath, opts.channel), "utf8");

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

  return resultsFromRunnerOutput(stdout, stderr);
}

/**
 * Turn the runner's stdout/stderr into per-test results — or, when the output shows the browser
 * binary was missing, throw ONE actionable error instead of silently reporting every test "failed".
 * Pure (no process/IO) so the failure-surfacing logic is unit-tested without spawning a runner.
 */
export function resultsFromRunnerOutput(stdout: string, stderr: string): RawTestResult[] {
  if (isMissingBrowserError(stderr) || isMissingBrowserError(stdout)) {
    throw missingBrowsersError("Playwright could not launch a browser to run the generated tests.");
  }
  const start = stdout.indexOf("{");
  if (start < 0) return [];
  try {
    return extract(JSON.parse(stdout.slice(start)) as PwJson);
  } catch {
    return [];
  }
}
