import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { noProcessImporter } from "./helpers/no-process-importer.js";
import { connectMcp, type McpConnection } from "../../src/mcp-test/connect.js";
import { discoverTools } from "../../src/mcp-test/discover.js";
import { McpCallGuard, type McpGuardOptions } from "../../src/mcp-test/guard.js";
import { countInternalErrors } from "../../src/mcp-test/report.js";
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

/** How the runner reaches a connection (the one place the tests name it). */
const linkOf = (conn: McpConnection, transport: Link["transport"] = "stdio"): Link => ({ invokeTool: (n, a, o) => conn.invokeTool(n, a, o), transport, dead: () => conn.dead });

async function connect(env: Record<string, string>, extra: Partial<Parameters<typeof connectMcp>[0]> = {}): Promise<McpConnection> {
  const c = await connectMcp({ command: [process.execPath, fixture], headers: {}, env, timeoutMs: 20000, ...extra });
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

async function harness(env: Record<string, string> = {}, allow: string[] = ["echo", "typed", "crash", "hang", "shifty", "plain"], connExtra: Partial<Parameters<typeof connectMcp>[0]> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cairn-mcp-runner-"));
  dirs.push(dir);
  const logFile = join(dir, "calls.log");
  const startsFile = join(dir, "starts.log");
  const fullEnv = { FIXTURE_LOG: logFile, FIXTURE_STARTS: startsFile, ...env };
  const conn = await connect(fullEnv, connExtra);
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
      const link: Link = linkOf(conn);
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

/** A minimal Streamable HTTP server whose tools/call (or tools/list, or an SSE call answer) floods `total` bytes and counts what it managed to write. */
async function bigHttp(total: number, mode: "call" | "list" | "sse" = "call"): Promise<{ url: string; written: () => number; close: () => Promise<void> }> {
  let written = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = req.method === "DELETE" ? 200 : 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      void (async () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
        const json = (result: unknown): void => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        };
        const tool = { name: "echo", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } };
        const flood = async (head: string, tail: string | undefined): Promise<void> => {
          res.setHeader("content-type", mode === "sse" ? "text/event-stream" : "application/json");
          res.write(head);
          const piece = "x".repeat(64 * 1024);
          for (let sent = 0; sent < total && !res.destroyed; sent += piece.length) {
            if (!res.write(piece)) await new Promise((ok) => (res.once("drain", ok), res.once("close", ok)));
            if (!res.destroyed) written += piece.length;
          }
          if (!res.destroyed && tail !== undefined) res.end(tail);
        };
        if (msg.id === undefined) {
          res.statusCode = 202;
          res.end();
        } else if (msg.method === "initialize") json({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "big", version: "1" } });
        else if (msg.method === "tools/list" && mode !== "list") json({ tools: [tool] });
        else if (msg.method === "tools/list") await flood(`{"jsonrpc":"2.0","id":${msg.id},"result":{"tools":[{"name":"echo","description":"`, '","inputSchema":{"type":"object"}}]}}');
        else if (mode === "sse") await flood(`event: message\ndata: {"jsonrpc":"2.0","id":${msg.id},"result":{"content":[{"type":"text","text":"`, undefined);
        else await flood(`{"jsonrpc":"2.0","id":${msg.id},"result":{"content":[{"type":"text","text":"`, '"}]}}');
      })();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, written: () => written, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

const sseHttp = (): ReturnType<typeof bigHttp> => bigHttp(500 * 1024 * 1024, "sse");

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
      return { ...linkOf(next), relist: () => discoverTools(next.source, { maxPages: 5, maxEntries: 100 }) };
    };
    const r = await h.run(
      [c("echo", "Positive", { q: "a" }), c("crash", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" }), c("crash", "Positive", { q: "b" }), c("echo", "Positive", { q: "c" }), c("echo", "Positive", { q: "d" })],
      { restart },
    );
    expect(r.results.map((x) => x.state)).toEqual(["passed", "failed", "passed", "failed", "could-not-run", "could-not-run"]);
    expect(r.restarts).toBe(1);
    expect(r.stopped).toMatch(/lost twice/);
    expect(r.results[4]?.reason).toMatch(/lost twice/);
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

describe("CLI · mcp-test · runner · what the server says is not what this side saw (review 1)", () => {
  it.each([
    ["-32000", "err32000"],
    ["-32001", "err32001"],
    ["an error whose text is 'Connection closed'", "errtext"],
  ])("a live server that answers %s is an ordinary error answer: judged by the case's rule, no restart, the run goes on", async (_label, mode) => {
    const h = await harness({ FIXTURE_ECHO: mode });
    const restart = async (): Promise<Link | undefined> => {
      throw new Error("a live server must not be restarted");
    };
    const r = await h.run([c("echo", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" }), c("echo", "Positive", { q: "c" }), c("echo", "Positive", { q: "d" })], { restart });
    expect(r.stopped).toBeUndefined();
    expect(r.restarts).toBe(0);
    expect(h.starts()).toHaveLength(1);
    expect(r.results.map((x) => x.state)).toEqual(["failed", "failed", "failed", "failed"]);
    for (const x of r.results) expect(x.reason).toContain("JSON-RPC error");
  });
});

describe("CLI · mcp-test · runner · an error code passes a Negative case only when the case lists it (review 4)", () => {
  it("-32602 passes; any other code is needs-review with the code named; isError passes", async () => {
    const strict = await (await harness()).run([c("echo", "Negative", { q: 5 })]);
    expect(one(strict)).toMatchObject({ state: "passed" });
    for (const [mode, code] of [["err32000", "-32000"], ["errtext", "-32603"]] as const) {
      const r = await (await harness({ FIXTURE_ECHO: mode })).run([c("echo", "Negative", { q: 5 })]);
      expect(one(r).state, mode).toBe("needs-review");
      expect(one(r).reason, mode).toContain(code);
    }
    const isErr = await (await harness({ FIXTURE_ECHO: "iserror" })).run([c("echo", "Negative", { q: 5 })]);
    expect(one(isErr).state).toBe("passed");
  });

  it("a robustness case follows its own accepts list literally", async () => {
    const only = (accepts: string[]) => robust("echo", { q: "a" }, { expect: { outcome: "robust", failedWhen: [], accepts } as RunnableCase["expect"] });
    const rpcOnly = await (await harness({ FIXTURE_ECHO: "iserror" })).run([only(["json-rpc-error", "accepted-without-harm"])]);
    expect(one(rpcOnly).state).toBe("needs-review");
    const isErrOk = await (await harness({ FIXTURE_ECHO: "iserror" })).run([only(["result-isError"])]);
    expect(one(isErrOk).state).toBe("passed");
    const noRpc = await (await harness({ FIXTURE_ECHO: "err32000" })).run([only(["result-isError", "accepted-without-harm"])]);
    expect(one(noRpc).state).toBe("needs-review");
    expect(one(noRpc).reason).toContain("-32000");
  });
});

describe("CLI · mcp-test · runner · the tool is read again before every call (review 3)", () => {
  it("a tool that changes after the 3rd call is refused from the 4th", async () => {
    const h = await harness({ FIXTURE_SHIFT_AFTER: "3" });
    const r = await h.run([1, 2, 3, 4, 5, 6].map((i) => c("shifty", "Positive", { q: String(i) })));
    expect(r.results.map((x) => x.state)).toEqual(["passed", "passed", "passed", "not-sent", "not-sent", "not-sent"]);
    expect(r.results[3]?.reason).toContain("changed since permission");
    expect(h.calls()).toHaveLength(3);
  });

  it("a list that cannot be read again means the call is not sent, and the case could not run (not a guard refusal)", async () => {
    const h = await harness({ FIXTURE_LIST_FAIL_FROM: "2" });
    const r = await h.run([c("echo", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" })]);
    expect(r.results.map((x) => x.state)).toEqual(["could-not-run", "could-not-run"]);
    expect(r.results[0]?.reason).toContain("the tool list could not be re-read");
    expect(h.calls()).toEqual([]);
  });
});

describe("CLI · mcp-test · runner · an output schema is compiled once per tool (review 9)", () => {
  it("a pattern that backtracks badly costs one timeout, not one per case", async () => {
    const h = await harness({ FIXTURE_EVIL: "1" }, ["echo", "evil"]);
    const start = Date.now();
    const r = await h.run(Array.from({ length: 10 }, (_, i) => c("evil", "Positive", { q: String(i) })));
    expect(Date.now() - start).toBeLessThan(7000);
    expect(r.results.map((x) => x.state)).toEqual(Array(10).fill("needs-review"));
    expect(r.results[9]?.reason).toMatch(/outputSchema could not be checked/);
  }, 40000);
});

describe("CLI · mcp-test · runner · the limit is applied while the answer is read (review 2)", () => {
  const LIMIT = 200_000;

  it("stdio: a message far over the limit is cut off by the reader, not kept; the counter shows what was read", async () => {
    const h = await harness({ FIXTURE_ECHO: "big", FIXTURE_BIG_BYTES: String(30 * 1024 * 1024) }, undefined, { maxResponseBytes: LIMIT });
    const r = await h.run([c("echo", "Positive", { q: "a" })], { maxResponseBytes: LIMIT });
    expect(one(r)).toMatchObject({ state: "needs-review", truncated: true });
    expect(one(r).response).toBeUndefined();
    expect(h.conn.bytesRead ?? Number.POSITIVE_INFINITY).toBeLessThan(3 * 1024 * 1024);
  }, 60000);

  it("HTTP: the body is read only up to the limit and the call fails locally; the connection stays usable", async () => {
    const total = 200 * 1024 * 1024;
    const srv = await bigHttp(total);
    try {
      const conn = await connectMcp({ url: srv.url, headers: {}, env: {}, timeoutMs: 20000, maxResponseBytes: LIMIT });
      conns.push(conn);
      const tools = await discoverTools(conn.source, { maxPages: 5, maxEntries: 100 });
      const guard = new McpCallGuard({ tools, allowTools: ["echo"], rps: 1000 });
      const r = await runCases([c("echo", "Positive", { q: "a" })], { guard, tools, link: linkOf(conn, "streamable-http"), callTimeoutMs: 10000, maxResponseBytes: LIMIT });
      expect(one(r)).toMatchObject({ state: "needs-review", truncated: true });
      expect(conn.bytesRead ?? Number.POSITIVE_INFINITY).toBeLessThan(3 * 1024 * 1024);
      expect(srv.written()).toBeLessThan(total / 4);
    } finally {
      await srv.close();
    }
  }, 60000);
});

describe("CLI · mcp-test · runner · restarts, budget, and the stop (review 7)", () => {
  it("results after the restart are marked afterRestart", async () => {
    const h = await harness();
    const restart = async (): Promise<Link | undefined> => {
      const next = await connect({ FIXTURE_LOG: h.logFile, FIXTURE_STARTS: h.startsFile });
      return { ...linkOf(next), relist: () => discoverTools(next.source, { maxPages: 5, maxEntries: 100 }) };
    };
    const r = await h.run([c("echo", "Positive", { q: "a" }), c("crash", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" })], { restart });
    expect(r.results.map((x) => x.afterRestart ?? false)).toEqual([false, false, true]);
    expect(r.restarts).toBe(1);
  }, 60000);

  it("cases that came after the time budget ran out are could-not-run with the budget reason, not not-sent", async () => {
    const h = await harness();
    let t = 0;
    const r = await h.run([c("echo", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" })], { guard: { timeBudgetMs: 450, now: () => (t += 100) } });
    expect(r.results.map((x) => x.state)).toEqual(["passed", "could-not-run"]);
    expect(r.results[1]?.reason).toMatch(/time budget/);
    expect(h.calls()).toHaveLength(1);
  });
});

describe("CLI · mcp-test · runner · second review", () => {
  it("1 · an interrupt in the middle of a call is not a server answer: could-not-run, the run stops, nothing more is sent", async () => {
    for (const make of [() => c("hang", "Positive", { q: "a" }), () => robust("hang", { q: "a" })]) {
      const h = await harness();
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 400);
      const r = await h.run([make(), c("echo", "Positive", { q: "b" })], { signal: stop.signal, callTimeoutMs: 20000 });
      expect(r.results.map((x) => x.state)).toEqual(["could-not-run", "could-not-run"]);
      expect(r.stopped).toMatch(/interrupted/);
      expect(h.calls().map((x) => x.tool)).toEqual(["hang"]);
    }
  }, 30000);

  const restartFor = (h: Harness) => async (): Promise<Link | undefined> => {
    const next = await connect({ FIXTURE_LOG: h.logFile, FIXTURE_STARTS: h.startsFile });
    return { ...linkOf(next), relist: () => discoverTools(next.source, { maxPages: 5, maxEntries: 100 }) };
  };

  it("2a · a server that dies between two cases: the re-read fails, that case is could-not-run (not not-sent), the server is started once, the run goes on", async () => {
    const h = await harness({ FIXTURE_EXIT_ON_LIST_AFTER: "2" });
    const r = await h.run([1, 2, 3, 4].map((i) => c("echo", "Positive", { q: String(i) })), { restart: restartFor(h) });
    expect(r.results.map((x) => x.state)).toEqual(["passed", "passed", "could-not-run", "passed"]);
    expect(r.restarts).toBe(1);
    expect(r.results[3]?.afterRestart).toBe(true);
  }, 60000);

  it("2a · without a restart the run is stopped, never green over unchecked cases", async () => {
    const h = await harness({ FIXTURE_EXIT_ON_LIST_AFTER: "2" });
    const r = await h.run([1, 2, 3, 4].map((i) => c("echo", "Positive", { q: String(i) })));
    expect(r.results.map((x) => x.state)).toEqual(["passed", "passed", "could-not-run", "could-not-run"]);
    expect(r.stopped).toBeDefined();
  }, 60000);

  it("2b · a tools/list over the message cap: the child is stopped, the case is could-not-run, the run stops, and little was read", async () => {
    const h = await harness({ FIXTURE_LIST_BYTES: String(30 * 1024 * 1024) }, undefined, { maxResponseBytes: 200_000 });
    const r = await h.run([c("echo", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" })]);
    expect(r.results.map((x) => x.state)).toEqual(["could-not-run", "could-not-run"]);
    expect(r.stopped).toBeDefined();
    expect(h.conn.bytesRead).toBeLessThan(4 * 1024 * 1024);
  }, 60000);

  it("5 · one restart budget for every cause: an oversized answer twice stops the run", async () => {
    const h = await harness({ FIXTURE_ECHO: "big", FIXTURE_BIG_BYTES: String(30 * 1024 * 1024) }, undefined, { maxResponseBytes: 200_000 });
    const r = await h.run([1, 2, 3, 4].map((i) => c("echo", "Positive", { q: String(i) })), { maxResponseBytes: 200_000, restart: async () => {
      const next = await connect({ FIXTURE_ECHO: "big", FIXTURE_BIG_BYTES: String(30 * 1024 * 1024), FIXTURE_LOG: h.logFile, FIXTURE_STARTS: h.startsFile }, { maxResponseBytes: 200_000 });
      return { ...linkOf(next), relist: () => discoverTools(next.source, { maxPages: 5, maxEntries: 100 }) };
    } });
    expect(r.results.map((x) => x.state)).toEqual(["needs-review", "needs-review", "could-not-run", "could-not-run"]);
    expect(r.restarts).toBe(1);
    expect(r.stopped).toBeDefined();
  }, 90000);

  it("6 · when the call budget is spent, the remaining cases are refused without a re-read", async () => {
    const h = await harness();
    let reads = 0;
    const r = await h.run([1, 2, 3, 4].map((i) => c("echo", "Positive", { q: String(i) })), { guard: { maxCalls: 1 }, relist: async () => {
      reads += 1;
      return h.tools;
    } });
    expect(r.results.map((x) => x.state)).toEqual(["passed", "not-sent", "not-sent", "not-sent"]);
    expect(reads).toBe(1);
  });

  it("7 · a restart that fails says what the server answered", async () => {
    const h = await harness();
    const r = await h.run([c("crash", "Positive", { q: "a" }), c("echo", "Positive", { q: "b" })], { restart: async () => ({ error: "the server answered initialize with an error (code -32000): nope" }) as never });
    expect(r.stopped).toContain("code -32000");
  });

  it("8 · the code of a JSON-RPC error is kept, and internal errors on hostile input are counted as advice", async () => {
    const h = await harness({ FIXTURE_ECHO: "errtext" });
    const r = await h.run([robust("echo", { q: "a" }, { style: "curious" })]);
    expect(one(r)).toMatchObject({ state: "passed", rpcCode: -32603 });
    expect(countInternalErrors(r.results)).toBe(1);
  });

  it("10 · an SSE answer cut for size ends the call at once, not at the call timer", async () => {
    const srv = await sseHttp();
    try {
      const conn = await connectMcp({ url: srv.url, headers: {}, env: {}, timeoutMs: 20000, maxResponseBytes: 200_000 });
      conns.push(conn);
      const tools = await discoverTools(conn.source, { maxPages: 5, maxEntries: 100 });
      const guard = new McpCallGuard({ tools, allowTools: ["echo"], rps: 1000 });
      const start = Date.now();
      const r = await runCases([c("echo", "Positive", { q: "a" })], { guard, tools, link: linkOf(conn, "streamable-http"), callTimeoutMs: 15000, maxResponseBytes: 200_000 });
      expect(one(r).state).toBe("needs-review");
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      await srv.close();
    }
  }, 30000);
});

describe("CLI · mcp-test · connect · second review", () => {
  it("3 · an HTTP tools/list page over the handshake limit stops being read", async () => {
    const srv = await bigHttp(50 * 1024 * 1024, "list");
    try {
      const conn = await connectMcp({ url: srv.url, headers: {}, env: {}, timeoutMs: 20000 });
      conns.push(conn);
      await expect(discoverTools(conn.source, { maxPages: 5, maxEntries: 100 })).rejects.toThrow();
      expect(conn.bytesRead).toBeLessThan(12 * 1024 * 1024);
      expect(srv.written()).toBeLessThan(25 * 1024 * 1024);
    } finally {
      await srv.close();
    }
  }, 60000);

  it("4 · a transport without the private process field is reported, not silently unchecked", async () => {
    const conn = await connectMcp({ command: [process.execPath, fixture], headers: {}, env: {}, timeoutMs: 20000, importer: noProcessImporter });
    conns.push(conn);
    expect(conn.sizeCounter).toBe("unavailable");
    const real = await connect({});
    expect(real.sizeCounter).toBe("active");
  }, 30000);
});

describe("CLI · mcp-test · connect · a server that ANSWERS initialize with an error (third review)", () => {
  /** A loopback Streamable HTTP server whose answer to initialize is a JSON-RPC error with `code`. */
  async function erroringHttp(code: number): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        const msg = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number }) : {};
        res.setHeader("content-type", "application/json");
        if (msg.id === undefined) {
          res.statusCode = req.method === "POST" ? 202 : 405;
          res.end();
        } else res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message: "no thanks" } }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
  }

  it.each([-32000, -32001, -32603])("over HTTP, an initialize error answer with code %i is reported as what the server answered, not as a closed connection", async (code) => {
    const srv = await erroringHttp(code);
    try {
      const err = await connectMcp({ url: srv.url, headers: {}, env: {}, timeoutMs: 5000 }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toContain(String(code));
      expect(err?.message).not.toMatch(/closed the connection|did not answer within/);
    } finally {
      await srv.close();
    }
  });
});
