// `cairn mcp` as a real process (the built dist/cli/index.js) over real stdio, from both protocol eras.
// tests/unit/mcp.test.ts drives the tools in memory with a mocked core; this file sees what only a process shows:
// the opening exchange, stdout, stderr and the exit. CI builds before it runs the tests; locally run `npm run build`
// first.
//
// Nothing here may reach a browser or a model: the core cannot be swapped from outside the process, so a tool call is
// made only with an argument the input schema refuses, which happens before the tool does any work. The process runs
// in an empty folder, and that folder stays empty (no runs/<id>/).
//
// Two clients:
// - legacy (2025-11-25, `initialize` handshake): the SDK 1.x Client;
// - modern (2026-07-28, per-request `_meta`, no handshake): JSON lines written to stdin by hand, shaped after the
//   specification, not after any SDK:
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "cli", "index.js");
const hidePackage = pathToFileURL(join(root, "tests", "fixtures", "hide-mcp-server-package.mjs")).href;

const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";
const TOOLS = ["automate", "design", "explore"];
/** A server that says nothing within this is «could not tell», never «works». */
const ANSWER_TIMEOUT_MS = 10_000;
/** Past this after stdin closes, the server did not leave on its own. */
const EXIT_BUDGET_MS = 3_000;

/** Made up; none may come back out of the process. */
const FAKE_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-e2e-never-printed-4b1d",
  OPENROUTER_API_KEY: "sk-or-e2e-never-printed-9c2e",
  GROQ_API_KEY: "gsk-e2e-never-printed-77aa",
  LANGFUSE_SECRET_KEY: "sk-lf-e2e-never-printed-31f0",
  LAYA_API_KEY: "laya-e2e-never-printed-5e6b",
  TYPESAFE_API_KEY: "ts-e2e-never-printed-0d8c",
};

let cwd = "";

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("dist/cli/index.js not found: run `npm run build` before this test.");
  cwd = mkdtempSync(join(tmpdir(), "cairn-mcp-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** This machine's environment without anything Cairn reads for keys or settings, plus the made-up keys. */
function serveEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /KEY|TOKEN|SECRET|^LLM_|^DECIDER|^LANGFUSE|^CAIRN_/i.test(k)) continue;
    env[k] = v;
  }
  // dotenv/config would read a .env from the working folder; point it at a file that does not exist.
  return { ...env, ...FAKE_KEYS, DOTENV_CONFIG_PATH: join(cwd, "no-such.env") };
}

function leakedKeys(text: string): string[] {
  return Object.entries(FAKE_KEYS)
    .filter(([, v]) => text.includes(v))
    .map(([k]) => k);
}

type Message = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

interface Serve {
  send(msg: Record<string, unknown>): void;
  /** The response with this id, or 'timeout' when the server stays silent. */
  answer(id: number): Promise<Message | "timeout">;
  /** Close stdin and wait for the exit; `ms` is null when it did not exit within the budget (it is then killed). */
  end(): Promise<{ code: number | null; ms: number | null }>;
  stdout(): string;
  stderr(): string;
}

function spawnServe(): Serve {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [cli, "mcp"], { cwd, env: serveEnv() });
  let out = "";
  let err = "";
  let buffered = "";
  const got: Message[] = [];
  const waiters: (() => void)[] = [];
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    out += d;
    buffered += d;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      try {
        got.push(JSON.parse(line) as Message);
      } catch {
        // not protocol: the stdout test reads `out` and fails on it
      }
    }
    for (const w of waiters.splice(0)) w();
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));

  return {
    send: (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`),
    answer: (id) =>
      new Promise((done) => {
        const timer = setTimeout(() => done("timeout"), ANSWER_TIMEOUT_MS);
        const check = () => {
          const m = got.find((g) => g.id === id && (g.result !== undefined || g.error !== undefined));
          if (m) {
            clearTimeout(timer);
            done(m);
          } else waiters.push(check);
        };
        check();
      }),
    async end() {
      const started = Date.now();
      child.stdin.end();
      const code = await Promise.race([exited, new Promise<"late">((r) => setTimeout(() => r("late"), EXIT_BUDGET_MS))]);
      if (code === "late") {
        child.kill();
        return { code: null, ms: null };
      }
      return { code, ms: Date.now() - started };
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/** `_meta` every 2026-07-28 request carries (protocol version and client capabilities are required). */
const modernMeta = () => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "cairn-e2e-modern", version: "1" },
});

const toolNames = (m: Message) => ((m.result?.["tools"] as { name: string }[] | undefined) ?? []).map((t) => t.name).sort();

/** A tool call that was refused: a protocol error, or a result marked as an error. Either way it names the argument. */
function refusal(m: Message): string | undefined {
  if (m.error) return `${m.error.message} ${JSON.stringify(m.error.data ?? "")}`;
  if (m.result?.["isError"] === true) return JSON.stringify(m.result["content"]);
  return undefined;
}

describe("CLI · mcp · legacy client (SDK 1.x, initialize)", () => {
  it("CLI · mcp · initialize, three tools, a call with an unknown decider is refused before any work, exit on stdin close", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd, env: serveEnv(), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "cairn-e2e-legacy", version: "1" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("cairn");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      const r = await client.callTool({ name: "design", arguments: { url: "http://127.0.0.1:9/", decider: "bogus" } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("decider");
    } finally {
      const started = Date.now();
      await client.close();
      // close() ends stdin and escalates to SIGTERM only after its own wait; quicker means the server left by itself.
      expect(Date.now() - started).toBeLessThan(EXIT_BUDGET_MS);
    }
    expect(readdirSync(cwd)).toEqual([]);
    expect(leakedKeys(stderr)).toEqual([]);
  });
});

describe("CLI · mcp · modern client (2026-07-28, JSON lines)", () => {
  it("CLI · mcp · server/discover as the first message returns a DiscoverResult naming 2026-07-28", async () => {
    const s = spawnServe();
    s.send({ id: 1, method: "server/discover", params: { _meta: modernMeta() } });
    const a = await s.answer(1);
    await s.end();
    if (a === "timeout") throw new Error("no answer to server/discover");
    expect(a.error).toBeUndefined();
    expect(a.result).toMatchObject({ resultType: "complete", capabilities: { tools: {} } });
    expect(a.result?.["supportedVersions"]).toContain(MODERN);
  });

  it("CLI · mcp · tools/list lists the three tools as a 2026-07-28 result; a call with an unknown decider is refused before any work", async () => {
    const s = spawnServe();
    s.send({ id: 1, method: "server/discover", params: { _meta: modernMeta() } });
    await s.answer(1);
    s.send({ id: 2, method: "tools/list", params: { _meta: modernMeta() } });
    const list = await s.answer(2);
    s.send({ id: 3, method: "tools/call", params: { name: "design", arguments: { url: "http://127.0.0.1:9/", decider: "bogus" }, _meta: modernMeta() } });
    const call = await s.answer(3);
    await s.end();
    if (list === "timeout" || call === "timeout") throw new Error("the server stayed silent");
    expect(list.result).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: expect.any(String) });
    expect(toolNames(list)).toEqual(TOOLS);
    expect(refusal(call)).toContain("decider");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("CLI · mcp · initialize with an unknown version is answered with the server's own latest legacy revision", async () => {
    const s = spawnServe();
    s.send({ id: 1, method: "initialize", params: { protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    const a = await s.answer(1);
    await s.end();
    if (a === "timeout") throw new Error("no answer");
    expect(a.result?.["protocolVersion"]).toBe(LEGACY);
  });
});

describe("CLI · mcp · stdio lifecycle", () => {
  it("CLI · mcp · stdout is protocol only, one message per line; stdin closed → exit 0; no provider key is printed", async () => {
    const s = spawnServe();
    s.send({ id: 1, method: "server/discover", params: { _meta: modernMeta() } });
    s.send({ id: 2, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    await s.answer(2);
    s.send({ method: "notifications/initialized" });
    s.send({ id: 3, method: "tools/list", params: {} });
    s.send({ id: 4, method: "tools/call", params: { name: "explore", arguments: { url: "http://127.0.0.1:9/", routing: "bogus" } } });
    for (const id of [1, 3, 4]) expect(await s.answer(id), `answer ${id}`).not.toBe("timeout");
    const exit = await s.end();

    const out = s.stdout();
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.slice(0, -1).split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line, "a line of stdout").not.toMatch(/\r/);
      const msg = JSON.parse(line) as Message; // a stray print, or a message with a line break inside, throws here
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id !== undefined || msg.method !== undefined).toBe(true);
    }
    expect(exit).toEqual({ code: 0, ms: expect.any(Number) });
    expect(leakedKeys(out)).toEqual([]);
    expect(leakedKeys(s.stderr())).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe("CLI · mcp · without the optional MCP server package", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", hidePackage, cli, ...args], { cwd, env: serveEnv(), input: "", encoding: "utf8", timeout: 30_000 });

  it("CLI · mcp · says what to install on stderr, prints nothing on stdout, exits 1", () => {
    const r = run(["mcp"]);
    expect(r.stderr).toContain("npm i @modelcontextprotocol/server");
    expect(r.stderr).not.toMatch(/\n\s+at /); // a sentence, not a stack
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
  });

  it("CLI · --version · other commands still run", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});
