import { describe, it, expect, afterAll } from "vitest";
import { rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { runExploration } from "../../src/agent/index.js";

// Runs land inside the project (spec resolution needs node_modules). Unreachable URL → observe fails
// BEFORE any LLM call, so no API key/credits are needed (the dummy key below is never used).
const BASE = join(process.cwd(), "runs", ".itest-hardening");

describe("runExploration hardening (integration, real browser, no LLM)", () => {
  afterAll(async () => {
    await rm(BASE, { recursive: true, force: true });
  });

  it("an unreachable URL → friendly error + partial report on disk, no crash", { timeout: 60000 }, async () => {
    await rm(BASE, { recursive: true, force: true });
    const config = loadConfig({ ANTHROPIC_API_KEY: "test-key-not-used" });

    let error: Error | undefined;
    try {
      await runExploration({ url: "http://127.0.0.1:9/nope", config, runsBaseDir: BASE });
    } catch (e) {
      error = e as Error;
    }

    // 1) it failed, but with a readable message — no raw JS stack trace.
    expect(error).toBeTruthy();
    expect(error!.message.toLowerCase()).toMatch(/could not (load|reach)|navigation|timed out/);
    expect(error!.message).not.toMatch(/\n\s+at .*\(/);

    // 2) a partial report landed on disk.
    const runDirs = await readdir(BASE);
    expect(runDirs).toHaveLength(1);
    const runDir = join(BASE, runDirs[0]!);
    const report = JSON.parse(await readFile(join(runDir, "report.json"), "utf8")) as { partial?: boolean };
    expect(report.partial).toBe(true);

    // 3) the summary points the user at that run dir. The summary normalizes the artifact path to
    // forward slashes for cross-platform display, so match the POSIX form regardless of the OS
    // separator `join` produced (on Windows runDir has backslashes; the message has forward slashes).
    expect(error!.message).toContain(runDir.replace(/\\/g, "/"));
  });
});
