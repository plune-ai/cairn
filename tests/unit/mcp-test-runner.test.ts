import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp, type McpConnection } from "../../src/mcp-test/connect.js";
import { discoverTools } from "../../src/mcp-test/discover.js";
import { McpCallGuard, type McpGuardOptions } from "../../src/mcp-test/guard.js";
import { runCases, type CaseResult, type Link, type RunnableCase, type RunnerOptions } from "../../src/mcp-test/runner.js";
import type { McpToolEntry } from "../../src/mcp-test/model.js";

/**
 * MCP-E5: the runner against a fixture server that this test starts on this machine (a stdio child). Every child is
 * stopped in afterEach and its process id is checked to be gone.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-runner-server.mjs");

let conns: McpConnection[] = [];
let dirs: string[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const c of conns) await c.close();
  conns = [];
  for (const d of dirs) {
    for (const f of readdirSync(d)) unlinkSync(join(d, f));
    rmdirSync(d);
  }
  dirs = [];
});

async function connect(env: Record<string, string>): Promise<McpConnection> {
  const c = await connectMcp({ command: [process.execPath, fixture], headers: {}, env, timeoutMs: 20000 });
  conns.push(c);
  return c;
}

interface Harness {
  conn: McpConnection;
  tools: McpToolEntry[];
  dir: string;
  logFile: string;
  startsFile: string;
  run(cases: RunnableCase[], o?: Partial<RunnerOptions> & { guard?: Partial<McpGuardOptions> }): Promise<ReturnType<typeof runCases>>;
  calls(): Array<{ tool: string; args: unknown }>;
  starts(): number[];
}

async function harness(env: Record<string, string> = {}, allow: string[] = ["echo", "typed", "crash", "hang", "shifty", "plain"]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cairn-mcp-runner-"));
  dirs.push(dir);
  const logFile = join(dir, "calls.log");
  const startsFile = join(dir, "starts.log");
  const fullEnv = { FIXTURE_LOG: logFile, FIXTURE_STARTS: startsFile, ...env };
  const conn = await connect(fullEnv);
  const tools = await discoverTools(conn.source, { maxPages: 5, maxEntries: 100 });
  const read = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  return {
    conn,
    tools,
    dir,
    logFile,
    startsFile,
    calls: () => read(logFile).map((l) => JSON.parse(l) as { tool: string; args: unknown }),
    starts: () => read(startsFile).map(Number),
    async run(cases, o = {}) {
      const { guard: guardOpts, ...rest } = o;
      const guard = new McpCallGuard({ tools, allowTools: allow, rps: 1000, ...guardOpts });
      const link: Link = { request: (r, opts) => conn.request(r, opts), transport: "stdio" };
      return runCases(cases, {
        guard,
        tools,
        link,
        relist: () => discoverTools(conn.source, { maxPages: 5, maxEntries: 100 }),
        callTimeoutMs: 5000,
        ...rest,
      });
    },
  };
}

let n = 0;
const c = (tool: string, type: "Positive" | "Negative", args: Record<string, unknown>, extra: Partial<RunnableCase> = {}): RunnableCase => {
  n += 1;
  const expect: RunnableCase["expect"] = type === "Positive" ? { outcome: "success" } : { outcome: "rejected" };
  return { name: `${tool} · ${type} · ${n}`, stableId: `id${n}`, tool, kind: "valid", type, args, expect, ...extra };
};
const robust = (tool: string, args: Record<string, unknown>, extra: Partial<RunnableCase> = {}): RunnableCase =>
  c(tool, "Positive", args, { style: undefined, expect: { outcome: "robust", failedWhen: ["process-exit", "connection-closed", "timeout", "http-5xx"] }, ...extra });
const one = (r: { results: CaseResult[] }): CaseResult => r.results[0] as CaseResult;
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe("CLI · mcp-test · runner · verdict rules (AC-3, AC-4, AC-5, AC-6)", () => {
  it("a Positive case that gets a success is passed, with one call and a masked request", async () => {
    const h = await harness();
    const r = await h.run([c("echo", "Positive", { q: "hello" })]);
    expect(one(r)).toMatchObject({ state: "passed" });
    expect(h.calls()).toEqual([{ tool: "echo", args: { q: "hello" } }]);
  });

  it("Positive + isError is needs-review, not failed and not passed (AC-4)", async () => {
    const r = await (await harness({ FIXTURE_ECHO: "iserror" })).run([c("echo", "Positive", { q: "x" })]);
    expect(one(r).state).toBe("needs-review");
  });

  it("Positive + a JSON-RPC error on a valid value is failed", async () => {
    const r = await (await harness()).run([c("echo", "Positive", { q: 5 })]);
    expect(one(r)).toMatchObject({ state: "failed", reason: expect.stringContaining("JSON-RPC error") });
  });

  it("Negative: a refusal passes; an accepted violating value fails with the schema text (AC-3)", async () => {
    const strict = await (await harness()).run([c("echo", "Negative", { q: 5 })]);
    expect(one(strict).state).toBe("passed");
    const lenient = await (await harness({ FIXTURE_ECHO: "lenient" })).run([c("echo", "Negative", { q: 5 })]);
    expect(one(lenient)).toMatchObject({ state: "failed", reason: "the server accepted a value that violates its schema" });
    const isErr = await (await harness({ FIXTURE_ECHO: "iserror" })).run([c("echo", "Negative", { q: 5 })]);
    expect(one(isErr).state).toBe("passed");
  });

  it("outputSchema: structuredContent that matches passes; absent or wrong is failed (AC-5)", async () => {
    for (const [mode, state] of [["good", "passed"], ["missing", "failed"], ["bad", "failed"]] as const) {
      const r = await (await harness({ FIXTURE_TYPED: mode })).run([c("typed", "Positive", { n: 1 })]);
      expect(one(r).state, mode).toBe(state);
    }
  });

  it("an answer larger than the limit is needs-review and is not kept (AC-6)", async () => {
    const r = await (await harness({ FIXTURE_ECHO: "big" })).run([c("echo", "Positive", { q: "x" })], { maxResponseBytes: 256 * 1024 });
    const x = one(r);
    expect(x).toMatchObject({ state: "needs-review", truncated: true });
    expect(x.response).toBeUndefined();
    expect(x.reason).toMatch(/larger than the limit/);
  });

  it("a human-oracle case is never passed by itself, and advice never changes a state", async () => {
    const plain = await (await harness()).run([robust("echo", { q: "' OR '1'='1" }, { humanOracle: true, style: undefined })]);
    expect(one(plain).state).toBe("needs-review");
    const noOracle = await (await harness()).run([robust("echo", { q: "a" })]);
    expect(one(noOracle).state).toBe("passed");
    const stack = await (await harness({ FIXTURE_ECHO: "stack" })).run([c("echo", "Positive", { q: "a" })]);
    const flat = await (await harness({ FIXTURE_ECHO: "iserror" })).run([c("echo", "Positive", { q: "a" })]);
    expect(one(stack).advice.length).toBeGreaterThan(0);
    expect(one(stack).state).toBe(one(flat).state);
    expect(JSON.stringify(one(stack).advice)).not.toContain("/srv/app");
  });
});

describe("CLI · mcp-test · runner · the guard and the calls (AC-8, AC-13)", () => {
  it("a refused case is not-sent with the guard's reason, never passed, and nothing reaches the server", async () => {
    const h = await harness({}, ["echo"]);
    const r = await h.run([c("plain", "Positive", {}), c("echo", "Positive", { q: "a" })]);
    expect(r.results.map((x) => x.state)).toEqual(["not-sent", "passed"]);
    expect(r.results[0]?.reason).toContain("not allowed");
    expect(h.calls().map((x) => x.tool)).toEqual(["echo"]);
  });

  it("an adversarial style without --allow-mutations is not sent", async () => {
    const h = await harness();
    const r = await h.run([c("echo", "Positive", { q: "a" }, { style: "psycho" })]);
    expect(one(r)).toMatchObject({ state: "not-sent" });
    expect(h.calls()).toEqual([]);
  });

  it("--max-calls counts every call; the rest are not-sent with the budget reason", async () => {
    const h = await harness();
    const r = await h.run([c("echo", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" }), c("echo", "Positive", { q: "c" })], { guard: { maxCalls: 1 } });
    expect(r.results.map((x) => x.state)).toEqual(["passed", "not-sent", "not-sent"]);
    expect(r.results[1]?.reason).toContain("budget exhausted");
    expect(h.calls()).toHaveLength(1);
  });

  it("a failed case is not repeated: exactly one tools/call per case (AC-13)", async () => {
    const h = await harness({ FIXTURE_ECHO: "lenient" });
    await h.run([c("echo", "Negative", { q: 5 }), c("echo", "Negative", { q: 6 })]);
    expect(h.calls()).toHaveLength(2);
  });

  it("a tool that changed after it was listed is refused as 'changed since permission' (observe)", async () => {
    const h = await harness();
    const r = await h.run([c("shifty", "Positive", { q: "a" }), c("echo", "Positive", { q: "a" })]);
    expect(r.results.map((x) => x.state)).toEqual(["not-sent", "passed"]);
    expect(r.results[0]?.reason).toContain("changed since permission");
    expect(h.calls().map((x) => x.tool)).toEqual(["echo"]);
  });
});

describe("CLI · mcp-test · runner · a server that dies or goes silent (AC-7, wall clock)", () => {
  it("the case that killed the process is failed, the server is started once more, a second death stops the run", async () => {
    const h = await harness();
    const restarts: McpConnection[] = [];
    const restart = async (): Promise<Link | undefined> => {
      const next = await connect({ FIXTURE_LOG: h.logFile, FIXTURE_STARTS: h.startsFile });
      restarts.push(next);
      return { request: (r, o) => next.request(r, o), transport: "stdio", relist: () => discoverTools(next.source, { maxPages: 5, maxEntries: 100 }) };
    };
    const r = await h.run(
      [c("echo", "Positive", { q: "a" }), c("crash", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" }), c("crash", "Positive", { q: "b" }), c("echo", "Positive", { q: "c" }), c("echo", "Positive", { q: "d" })],
      { restart },
    );
    expect(r.results.map((x) => x.state)).toEqual(["passed", "failed", "passed", "failed", "could-not-run", "could-not-run"]);
    expect(r.restarts).toBe(1);
    expect(r.stopped).toMatch(/exited twice/);
    expect(r.results[4]?.reason).toMatch(/exited twice/);
    expect(h.starts()).toHaveLength(2);
    const pids = h.starts();
    for (const x of conns) await x.close();
    await wait(300);
    for (const pid of pids) expect(alive(pid), `pid ${pid} is gone`).toBe(false);
  }, 60000);

  it("a server that never answers cannot hang the run: the timeout is enforced, silence stops the run", async () => {
    const h = await harness();
    const start = Date.now();
    const r = await h.run(
      [robust("hang", { q: "a" }), c("hang", "Positive", { q: "b" }), c("hang", "Positive", { q: "c" }), c("echo", "Positive", { q: "d" })],
      { callTimeoutMs: 400 },
    );
    expect(Date.now() - start).toBeLessThan(8000);
    // The first was answered by nobody, but the server was alive before it (the start of the connection) and the case says timeout is a failure.
    expect(r.results.map((x) => x.state)).toEqual(["failed", "could-not-run", "could-not-run", "could-not-run"]);
    expect(r.stopped).toMatch(/in a row/);
  }, 30000);
});

describe("CLI · mcp-test · runner · secrets (AC-12)", () => {
  it("a secret the server echoes and a value under a sensitive key are masked in what is kept", async () => {
    const h = await harness({ FIXTURE_ECHO: "leak", FIXTURE_LEAK: "leakvalue-secret-9999" });
    const r = await h.run([c("echo", "Positive", { q: "a" })], { secrets: ["leakvalue-secret-9999"] });
    const text = JSON.stringify(r.results);
    expect(text).not.toContain("leakvalue-secret-9999");
    expect(text).not.toContain("fixture-key-value-1234");
    expect(one(r).response).toContain("***");
  });
});
