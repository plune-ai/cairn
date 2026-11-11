// The MCP lint step of CI (.github/workflows/ci.yml), run here the way the step runs it: scripts/mcp-self-lint.mjs,
// the pinned published plune CLI against a server. Green on the built `cairn mcp` (CI builds before it runs the tests;
// locally run `npm run build` first), red on a broken server, one that cannot start and one with no tools, so the
// step cannot be green on nothing. A free string where an enum belongs is a heuristic finding: printed, never red.
// The first run downloads the pinned CLI through npx; in CI the lint step before the tests has already fetched it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "cli", "index.js");
const script = join(root, "scripts", "mcp-self-lint.mjs");
const fixture = join(root, "tests", "fixtures", "mcp-self-lint-server.mjs");
/** npx may fetch the CLI on the first run. */
const STEP_TIMEOUT_MS = 120_000;

let dir = "";
let runs = 0;

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("dist/cli/index.js not found: run `npm run build` before this test.");
  dir = mkdtempSync(join(tmpdir(), "cairn-mcp-self-lint-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** This environment without a provider key, plus `extra`. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$/i.test(k)) out[k] = v;
  return { ...out, ...extra };
}

/** The step against a server command, its JUnit read back. */
function step(server: string[], extra?: Record<string, string>) {
  const out = join(dir, `run-${++runs}`);
  const r = spawnSync(process.execPath, [script, out, "--", ...server], {
    cwd: root,
    env: env(extra),
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
  });
  const file = join(out, "lint.xml");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, junit: existsSync(file) ? readFileSync(file, "utf8") : null };
}

const fixtureServer = (mode: string) => [process.execPath, fixture, mode];

describe("CI · mcp lint step · the pinned plune mcp lint against cairn mcp", () => {
  it("CI · mcp lint step · green on the built cairn mcp, with a JUnit file", () => {
    const r = step([process.execPath, cli, "mcp"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.junit).toContain("<testcase");
  }, STEP_TIMEOUT_MS);

  it("CI · mcp lint step · a duplicate tool name and a non-object input schema are exit 1 with failed cases", () => {
    const r = step(fixtureServer("broken"));
    expect(r.status, r.stderr).toBe(1);
    expect(r.junit).toMatch(/<testcase[^>]*name="name-duplicate"[^>]*>\s*<failure/);
    expect(r.junit).toMatch(/<testcase[^>]*name="input-schema-not-object"[^>]*>\s*<failure/);
  }, STEP_TIMEOUT_MS);

  it("CI · mcp lint step · a free string where an enum belongs is printed as a heuristic warning and does not fail", () => {
    const r = step(fixtureServer("free-string"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("param-enum-in-text");
  }, STEP_TIMEOUT_MS);

  it("CI · mcp lint step · a server that cannot start is exit 2", () => {
    expect(step(fixtureServer("crash")).status).toBe(2);
  }, STEP_TIMEOUT_MS);

  it("CI · mcp lint step · an empty tools/list is exit 3: nothing measured is not clean", () => {
    const r = step(fixtureServer("empty"));
    expect(r.status, r.stderr).toBe(3);
    expect(r.junit).toContain('type="could-not-run"');
  }, STEP_TIMEOUT_MS);

  it("CI · mcp lint step · a provider key in the environment stops it before any server starts", () => {
    const r = step(fixtureServer("empty"), { ANTHROPIC_API_KEY: "sk-ant-never-used" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
    expect(r.stderr).not.toContain("sk-ant-never-used");
    expect(r.junit).toBeNull();
  }, STEP_TIMEOUT_MS);
});
