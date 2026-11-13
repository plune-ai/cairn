import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMcpTest, type McpTestOptions } from "../../src/mcp-test/run.js";
import { failingImporter, noProcessImporter } from "./helpers/no-process-importer.js";
import { computeMcpCoverage, evaluateMcpGate } from "../../src/mcp-test/coverage.js";
import { mcpExitCode } from "../../src/mcp-test/report.js";
import type { CaseResult } from "../../src/mcp-test/runner.js";

/**
 * MCP-E5, command level: `runMcpTest` against the runner fixture, a stdio server this test starts on this machine.
 * Every run closes its child; afterEach also kills any process id the fixture recorded and checks it is gone.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-runner-server.mjs");

let dirs: string[] = [];
let out: string[] = [];
let err: string[] = [];
const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };

beforeEach(() => {
  out = [];
  err = [];
});

afterEach(() => {
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        try {
          unlinkSync(p);
        } catch {
          for (const g of readdirSync(p)) unlinkSync(join(p, g));
          rmdirSync(p);
        }
      }
      rmdirSync(d);
    } catch {
      /* best effort */
    }
  }
  dirs = [];
  process.exitCode = 0;
});

const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cairn-mcp-run-"));
  dirs.push(d);
  return d;
};

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function run(vars: Record<string, string>, extra: McpTestOptions = {}) {
  const o = dir();
  const logFile = join(o, "..", `${o.split(/[\\/]/).pop()}.calls`);
  const startsFile = join(o, "..", `${o.split(/[\\/]/).pop()}.starts`);
  const env = Object.entries({ FIXTURE_LOG: logFile, FIXTURE_STARTS: startsFile, ...vars }).map(([k, v]) => `${k}=${v}`);
  const r = await runMcpTest({ command: [process.execPath, fixture], out: o, env, timeout: 20, callTimeout: 5, ...extra }, io);
  const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  const calls = lines(logFile).map((l) => JSON.parse(l) as { tool: string; args: unknown });
  const starts = lines(startsFile).map(Number);
  for (const f of [logFile, startsFile]) if (existsSync(f)) unlinkSync(f);
  // Every server process this run started must be gone (checked by process id, not by a name).
  for (const p of starts) for (let i = 0; i < 30 && !gone(p); i++) await new Promise((res) => setTimeout(res, 100));
  for (const p of starts) expect(gone(p), `server process ${p} is still alive`).toBe(true);
  const read = (f: string): string => readFileSync(join(o, f), "utf8");
  return { r, o, calls, starts, read };
}

describe("CLI · mcp-test · runner · command level", () => {
  it("with no flag that sends calls, no call reaches the server and the exit code is 0 (AC-1)", async () => {
    const x = await run({});
    expect(x.r.exitCode).toBe(0);
    expect(x.calls).toEqual([]);
    expect(existsSync(join(x.o, "report.json"))).toBe(false);
  });

  it("sends one call per case through the guard and writes the artifacts (AC-2, AC-9, AC-10)", async () => {
    const x = await run({}, { allowTools: "echo,typed", maxCalls: 50 });
    const report = JSON.parse(x.read("report.json"));
    expect(report).toMatchObject({ schemaVersion: 1, mode: "mcp", cost: { usd: 0, tokens: 0, model: false } });
    expect(report.runId).toBe(x.o.split(/[\\/]/).pop());
    expect(report.mcp.toolCount).toBe(6);
    expect(report.mcp.total).toBe(x.calls.length);
    expect(report.mcp.passed).toBeGreaterThan(0);
    expect(report.cases.every((c: { stableId: string }) => c.stableId.length > 0)).toBe(true);
    expect(report.guardrails).toBeDefined();
    const names = readdirSync(x.o);
    for (const f of ["report.md", "mcp-model.json", "mcp-cases.json", "mcp-evidence.json", "mcp-calls.jsonl", "testcases"]) expect(names).toContain(f);
    const docs = readdirSync(join(x.o, "testcases"));
    expect(docs.length).toBe(report.cases.length);
    expect(new Set(docs).size).toBe(docs.length);
    expect(new Set(report.cases.map((c: { name: string }) => c.name)).size).toBe(report.cases.length);
    expect(readFileSync(join(x.o, "testcases", docs[0] as string), "utf8")).toMatch(/^stableId: /m);
    // Only the allowed tools were called.
    expect(new Set(x.calls.map((c) => c.tool))).toEqual(new Set(["echo", "typed"]));
  });

  it("an unknown --allow-tools name sends nothing and is an error (AC-11)", async () => {
    const x = await run({}, { allowTools: "no-such-tool" });
    expect(x.calls).toEqual([]);
    expect(x.r.exitCode).toBe(1);
    expect(err.join("")).toMatch(/does not have/);
  });

  it("when every answer was over the limit, nothing is proven: exit 5, not 0, and the other tools are named as not measured (AC-11)", async () => {
    const x = await run({ FIXTURE_ECHO: "big" }, { allowTools: "echo", maxCalls: 50, maxResponseBytes: 1000 });
    expect(x.calls.length).toBeGreaterThan(0);
    expect(x.r.exitCode).toBe(5);
    expect(err.join("")).toMatch(/Nothing was proven/);
    expect(out.join("")).toMatch(/Not measured.*typed/);
    const ev = JSON.parse(x.read("mcp-evidence.json")) as Array<{ state: string; response?: unknown }>;
    expect(ev.filter((e) => e.state !== "not-sent").every((e) => e.state === "needs-review")).toBe(true);
    expect(JSON.stringify(ev)).not.toContain("xxxxxxxxxxxxxxxxxxxx");
  });

  it("a failing server answer gives exit 1; an advice never changes the code (AC-3, AC-12)", async () => {
    const lenient = await run({ FIXTURE_ECHO: "lenient" }, { allowTools: "echo", maxCalls: 50 });
    expect(lenient.r.exitCode).toBe(1);
    const stack = await run({ FIXTURE_ECHO: "stack" }, { allowTools: "echo", maxCalls: 50 });
    const ev = JSON.parse(stack.read("mcp-evidence.json")) as Array<{ advice: unknown[]; state: string }>;
    expect(ev.some((e) => e.advice.length > 0)).toBe(true);
    const stateOfAdviceCases = ev.filter((e) => e.advice.length > 0).map((e) => e.state);
    expect(stateOfAdviceCases.every((s) => s === "needs-review" || s === "passed")).toBe(true);
  });

  it("an answer with a secret in it is masked everywhere on disk and on screen (AC-13)", async () => {
    const secret = "sk-live-fixture-secret-9f8e7d6c5b4a";
    const x = await run({ FIXTURE_ECHO: "leak", FIXTURE_LEAK: secret }, { allowTools: "echo", maxCalls: 50 });
    const files = readdirSync(x.o, { recursive: true }) as string[];
    const text = [...out, ...err, ...files.filter((f) => /\.(json|md|jsonl)$/.test(f)).map((f) => readFileSync(join(x.o, f), "utf8"))].join("\n");
    expect(text).not.toContain("fixture-key-value-1234");
  });

  it("--min-coverage fails the run with exit 3 when tools are not covered (AC-8)", async () => {
    const x = await run({}, { allowTools: "echo", maxCalls: 50, minCoverage: 100 });
    expect([1, 3]).toContain(x.r.exitCode);
    if (x.r.exitCode === 3) expect(JSON.parse(x.read("report.json")).coverageGate.passed).toBe(false);
    expect(out.join("")).toMatch(/Coverage gate: FAILED/);
  });

  it("a call budget of 1 sends one call and exits 4 (AC-14)", async () => {
    const x = await run({}, { allowTools: "echo", maxCalls: 1 });
    expect(x.calls.length).toBe(1);
    expect(x.r.exitCode).toBe(4);
  });
});

describe("MCP-E5 · coverage and exit code rules", () => {
  const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: { q: { type: "string" } } } }) as never;
  const res = (name: string, state: CaseResult["state"]) => ({ name, stableId: name, state }) as CaseResult;
  const cs = (name: string, t: string) => ({ stableId: name, name, tool: t, args: { q: "a" } });

  it("a case that was not sent covers nothing; the tool is uncovered and named", () => {
    const c = computeMcpCoverage([tool("a"), tool("b")], [cs("1", "a"), cs("2", "b")], [res("1", "passed"), res("2", "not-sent")]);
    expect(c.tools.map((t) => t.status)).toEqual(["covered", "uncovered"]);
    expect(c.notMeasured).toEqual(["b"]);
  });

  it("no tools never passes a gate", () => {
    const c = computeMcpCoverage([], [], []);
    expect(evaluateMcpGate(c, 0).passed).toBe(false);
  });

  it("partial counts only with --count-partial", () => {
    const t = { name: "a", inputSchema: { type: "object", properties: { q: {}, r: {} } } } as never;
    const c = computeMcpCoverage([t], [cs("1", "a")], [res("1", "passed")]);
    expect(c.tools[0]?.status).toBe("partial");
    expect(evaluateMcpGate(c, 100).passed).toBe(false);
    expect(evaluateMcpGate(c, 100, true).passed).toBe(true);
  });

  it("exit codes: failed 1, coverage 3, budget 4, nothing proven 5, needs-review alone is not green", () => {
    const base = { budgetExhausted: false };
    expect(mcpExitCode({ ...base, results: [res("1", "passed")] })).toBe(0);
    expect(mcpExitCode({ ...base, results: [res("1", "passed"), res("2", "failed")] })).toBe(1);
    expect(mcpExitCode({ ...base, results: [res("1", "needs-review")] })).toBe(5);
    expect(mcpExitCode({ ...base, results: [res("1", "not-sent")] })).toBe(5);
    expect(mcpExitCode({ ...base, budgetExhausted: true, results: [res("1", "passed")] })).toBe(4);
    const gate = { passed: false } as never;
    expect(mcpExitCode({ ...base, gate, results: [res("1", "passed")] })).toBe(3);
  });

  it("exit 0 only when no case was left unjudged: could-not-run or needs-review beside a pass is 5, a guard refusal is the user's choice", () => {
    const base = { budgetExhausted: false };
    expect(mcpExitCode({ ...base, results: [res("1", "passed"), res("2", "could-not-run")] })).toBe(5);
    expect(mcpExitCode({ ...base, results: [res("1", "passed"), res("2", "needs-review")] })).toBe(5);
    expect(mcpExitCode({ ...base, results: [res("1", "passed"), res("2", "not-sent")] })).toBe(0);
    // Precedence: failed 1, coverage 3, budget 4, not proven 5.
    expect(mcpExitCode({ ...base, results: [res("1", "failed"), res("2", "could-not-run")] })).toBe(1);
    expect(mcpExitCode({ ...base, budgetExhausted: true, results: [res("1", "passed"), res("2", "could-not-run")] })).toBe(4);
    expect(mcpExitCode({ ...base, stopped: "gone", results: [res("1", "passed")] })).toBe(1);
  });
});

describe("CLI · mcp-test · runner · HTTP, the call without credentials", () => {
  const modelFixture = resolve(here, "..", "fixtures", "mcp-model-server.mjs");
  const TOKEN = "the-right-one-4455";

  it("sends it once, through the guard, without the Authorization header; a server that refuses it is not a failure", async () => {
    const fx = await ((await import(modelFixture)) as { startHttpFixture: (o: object) => Promise<{ url: string; close: () => Promise<void> }> }).startHttpFixture({ requireAuth: `Bearer ${TOKEN}` });
    try {
      const o = dir();
      await runMcpTest({ url: fx.url, out: o, timeout: 20, callTimeout: 5, allowTools: "search_notes", allowMutations: true, adversarial: "hacker", maxCalls: 100, header: [`Authorization: Bearer ${TOKEN}`] }, io);
      const report = JSON.parse(readFileSync(join(o, "report.json"), "utf8"));
      const anon = report.cases.filter((c: { kind: string }) => c.kind === "no-credentials");
      expect(anon, [...out, ...err].join("")).toHaveLength(1);
      expect(anon[0].state).not.toBe("failed");
      expect(JSON.stringify(report)).not.toContain(TOKEN);
      expect(readFileSync(join(o, "mcp-calls.jsonl"), "utf8")).not.toContain(TOKEN);
    } finally {
      await fx.close();
    }
  });
});

describe("CLI · mcp-test · adversarial criteria the runner unblocks", () => {
  it("the fixture sees an own __proto__ key and a lone surrogate, and a refusal or an accepted value is not a failure", async () => {
    const x = await run({}, { allowTools: "echo", allowMutations: true, adversarial: true, maxCalls: 400, rps: 1000, maxCasesPerTool: 200, adversarialMaxString: 50 });
    const raw = x.calls.map((c) => JSON.stringify(c.args));
    expect(readFileSync(join(x.o, "mcp-calls.jsonl"), "utf8")).toContain("__proto__");
    expect(raw.some((s) => /\ud[89ab][0-9a-f]{2}(?!\ud[c-f])/i.test(s))).toBe(true);
    const ev = JSON.parse(x.read("mcp-evidence.json")) as Array<{ tool: string; state: string }>;
    expect(ev.some((e) => e.tool === "echo" && e.state === "passed")).toBe(true);
  });

  it("a server process that exits during a call fails that case; the run restarts once and a second exit stops it, the rest not measured", async () => {
    const x = await run({}, { allowTools: "crash", maxCalls: 50 });
    const ev = JSON.parse(x.read("mcp-evidence.json")) as Array<{ state: string; reason: string }>;
    expect(ev.filter((e) => e.state === "failed").length).toBeGreaterThan(0);
    expect(ev.some((e) => e.state === "could-not-run")).toBe(true);
    expect(x.starts.length).toBeGreaterThanOrEqual(2);
    expect(x.r.exitCode).toBe(1);
    expect(err.join("")).toMatch(/stopped early/);
  });
});

describe("CLI · mcp-test · --max-response-bytes and the stop", () => {
  it.each(["0", "-5", "1e3", "0x10", "67108865", "abc"])("%s is a usage error and nothing is connected", async (v) => {
    await expect(run({}, { allowTools: "echo", maxResponseBytes: v })).rejects.toThrow(/--max-response-bytes/);
  });

  it("an HTTP run that was stopped does not send the call without credentials", async () => {
    const modelFixture2 = resolve(here, "..", "fixtures", "mcp-model-server.mjs");
    const fx = await ((await import(modelFixture2)) as { startHttpFixture: (o: object) => Promise<{ url: string; close: () => Promise<void> }> }).startHttpFixture({ requireAuth: "Bearer tok-stop-1234" });
    try {
      const o = dir();
      await runMcpTest({ url: fx.url, out: o, timeout: 20, callTimeout: 5, allowTools: "search_notes", allowMutations: true, adversarial: "hacker", maxCalls: 1, header: ["Authorization: Bearer tok-stop-1234"] }, io);
      const report = JSON.parse(readFileSync(join(o, "report.json"), "utf8"));
      expect(report.cases.filter((c: { kind: string }) => c.kind === "no-credentials")).toEqual([]);
      expect(report.guardrails.budgetExhausted).toBe(true);
    } finally {
      await fx.close();
    }
  });
});

describe("CLI · mcp-test · second review, command level", () => {
  it("4 · when the stdio size counter cannot be installed, the console and report.json say so", async () => {
    const x = await run({}, { allowTools: "echo", maxCalls: 50, importer: noProcessImporter });
    expect(err.join("")).toMatch(/the stdio size counter is unavailable with this SDK version: only the transport's own limit applies/);
    expect(JSON.parse(x.read("report.json")).stdioSizeCounter).toBe("unavailable");
  });

  it("4 · with the counter, no such line and the flag says active", async () => {
    const x = await run({}, { allowTools: "echo", maxCalls: 50 });
    expect(err.join("")).not.toMatch(/size counter is unavailable/);
    expect(JSON.parse(x.read("report.json")).stdioSizeCounter).toBe("active");
  });

  it("7 · a server that answers initialize with -32000 is reported as what it answered, not as 'closed' or 'did not answer'", async () => {
    const o = dir();
    const r = await runMcpTest({ command: [process.execPath, resolve(here, "..", "fixtures", "mcp-model-server.mjs")], out: o, env: ["FIXTURE_MODE=init-error", "FIXTURE_ERROR_CODE=-32000"], timeout: 20 }, io);
    expect(r.exitCode).not.toBe(0);
    const text = err.join("");
    expect(text).toContain("-32000");
    expect(text).not.toMatch(/closed the connection before it answered|did not answer within/);
  });

  it("8 · the summary counts internal errors on hostile input, and they change no exit code", async () => {
    const x = await run({ FIXTURE_ECHO: "errtext" }, { allowTools: "echo", allowMutations: true, adversarial: true, maxCalls: 400, rps: 1000, maxCasesPerTool: 200, adversarialMaxString: 50 });
    expect(out.join("")).toMatch(/internal error/i);
    expect(JSON.parse(x.read("report.json")).advice.internalErrorsOnHostileInput).toBeGreaterThan(0);
  });
});

describe("CLI · mcp-test · the size counter flag keeps the last live value after a failed restart", () => {
  it("remembers the value of the last live connection; the restart that failed does not turn it into 'active'", async () => {
    const x = await run({}, { allowTools: "echo,crash", maxCalls: 50, importer: failingImporter(2) });
    const report = JSON.parse(x.read("report.json"));
    expect(report.stopped, JSON.stringify([report.stopped, out.join("").slice(-600), err.join("")])).toMatch(/could not be started again/);
    expect(report.stdioSizeCounter).toBe("unavailable");
  });
});
