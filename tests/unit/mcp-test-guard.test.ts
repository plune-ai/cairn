import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpCallGuard,
  MUTATION_BANNER,
  assessTools,
  parseAllowTools,
  readsDestructive,
  renderGuardReport,
  renderProposal,
  unknownToolNames,
  type McpGuardOptions,
} from "../../src/mcp-test/guard.js";
import { appendCallLog, describeArguments, guardedToolCall, CALL_LOG_FILE, LocalFailure, type ToolRpc } from "../../src/mcp-test/call.js";
import { runMcpTest } from "../../src/mcp-test/run.js";
import type { McpToolEntry } from "../../src/mcp-test/model.js";

/**
 * MCP-E4: the guard decides before every tool call. The guard is a pure class (clock and sleep are injected), so its
 * cells are tested without a server; the command's flags are tested against the fixture server, which writes down every
 * call that reaches it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-model-server.mjs");

const tool = (name: string, annotations?: Record<string, unknown>, extra: Partial<McpToolEntry> = {}): McpToolEntry => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
  ...extra,
});

/** The server of the lying cases: it claims read-only for a tool that deletes, and for one that could write. */
const TOOLS: McpToolEntry[] = [
  tool("get_report", { readOnlyHint: true }),
  tool("delete_everything", { readOnlyHint: true }),
  tool("list_items", { readOnlyHint: true }),
  tool("update_item", { readOnlyHint: false }),
  tool("mystery"),
];

const make = (o: Partial<McpGuardOptions> = {}): McpCallGuard => new McpCallGuard({ tools: TOOLS, ...o });

describe("CLI · mcp-test · guard · the default allows nothing (AC-1)", () => {
  it("with no flag every tool is refused, a read-only claim included", () => {
    const g = make();
    for (const t of TOOLS) expect(g.decide({ tool: t.name }), t.name).toMatchObject({ allowed: false });
    expect(g.decide({ tool: "get_report" }).reason).toBe("not allowed");
  });

  it("nothing sent is exit code 5, never a pass", async () => {
    const g = make();
    for (const t of TOOLS) await g.admit({ tool: t.name });
    expect(g.report().sent).toBe(0);
    expect(g.exitCode()).toBe(5);
  });

  it("--allow-mutations alone allows nothing", () => {
    const g = make({ allowMutations: true });
    for (const t of TOOLS) expect(g.decide({ tool: t.name }).allowed, t.name).toBe(false);
    expect(g.report().notes.join(" ")).toMatch(/allows nothing/);
  });
});

describe("CLI · mcp-test · guard · what the server says is not a proof (AC-2, AC-3)", () => {
  it("AC-2: get_report (claims read-only) is not called without a permission, is with its name or with the trust flag", () => {
    expect(make().decide({ tool: "get_report" }).allowed).toBe(false);
    expect(make({ allowTools: ["get_report"] }).decide({ tool: "get_report" })).toMatchObject({ allowed: true, basis: "named" });
    expect(make({ allowReadOnlyHints: true }).decide({ tool: "get_report" })).toMatchObject({ allowed: true, basis: "server-claim" });
  });

  it("AC-2: the report says a permission from the trust flag rests on the server's claim", async () => {
    const g = make({ allowReadOnlyHints: true });
    await g.admit({ tool: "get_report" });
    const r = g.report();
    expect(r.restsOnServerClaims).toBe(true);
    expect(renderGuardReport(r).join("\n")).toMatch(/server's own claim/);
    const named = make({ allowTools: ["get_report"] });
    await named.admit({ tool: "get_report" });
    expect(named.report().restsOnServerClaims).toBe(false);
  });

  it("the trust flag does not allow a tool without a hint, or one with readOnlyHint false", () => {
    const g = make({ allowReadOnlyHints: true });
    expect(g.decide({ tool: "mystery" }).allowed).toBe(false);
    expect(g.decide({ tool: "update_item" }).allowed).toBe(false);
  });

  it("AC-3: delete_everything (claims read-only) is refused with the trust flag, and with its name alone", () => {
    expect(make({ allowReadOnlyHints: true }).decide({ tool: "delete_everything" })).toMatchObject({ allowed: false, reason: "destructive name" });
    expect(make({ allowTools: ["delete_everything"] }).decide({ tool: "delete_everything" })).toMatchObject({ allowed: false, reason: "destructive name" });
    expect(make({ allowTools: ["delete_everything"], allowReadOnlyHints: true }).decide({ tool: "delete_everything" }).allowed).toBe(false);
    expect(make({ allowMutations: true }).decide({ tool: "delete_everything" }).allowed).toBe(false);
  });

  it("AC-3: only its name together with --allow-mutations lets it through, and the report names the disagreement", () => {
    const g = make({ allowTools: ["delete_everything"], allowMutations: true });
    expect(g.decide({ tool: "delete_everything" })).toMatchObject({ allowed: true, reason: "named in --allow-tools with --allow-mutations" });
    const r = g.report();
    expect(r.mismatches).toEqual([{ tool: "delete_everything", detail: expect.stringMatching(/read-only.*deletion/) }]);
    expect(renderGuardReport(r).join("\n")).toMatch(/Hint and name disagree/);
  });

  it("a tool the server marks destructive never passes on a read-only claim", () => {
    const tools = [tool("sync_all", { readOnlyHint: true, destructiveHint: true })];
    expect(assessTools(tools)[0]).toMatchObject({ class: "mutating", proposed: false });
    expect(new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: "sync_all" }).allowed).toBe(false);
    expect(new McpCallGuard({ tools, allowTools: ["sync_all"] }).decide({ tool: "sync_all" }).allowed).toBe(false);
    expect(new McpCallGuard({ tools, allowTools: ["sync_all"], allowMutations: true }).decide({ tool: "sync_all" }).allowed).toBe(true);
  });
});

describe("CLI · mcp-test · guard · the permission model (AC-5)", () => {
  it("a tool that is not proven read-only needs its name AND --allow-mutations", () => {
    expect(make({ allowTools: ["update_item"] }).decide({ tool: "update_item" })).toMatchObject({ allowed: false, reason: "mutations not allowed" });
    expect(make({ allowTools: ["mystery"] }).decide({ tool: "mystery" })).toMatchObject({ allowed: false, reason: "mutations not allowed" });
    expect(make({ allowTools: ["update_item"], allowMutations: true }).decide({ tool: "update_item" }).allowed).toBe(true);
    expect(make({ allowTools: ["mystery"], allowMutations: true }).decide({ tool: "mystery" }).allowed).toBe(true);
  });

  it("with both, only the named tools are allowed", () => {
    const g = make({ allowTools: ["update_item"], allowMutations: true });
    expect(g.decide({ tool: "update_item" }).allowed).toBe(true);
    expect(g.decide({ tool: "mystery" })).toMatchObject({ allowed: false, reason: "not allowed" });
    expect(g.decide({ tool: "get_report" }).allowed).toBe(false);
  });

  it("the psycho and hacker styles are mutations whatever the hint", () => {
    const named = make({ allowTools: ["get_report"] });
    expect(named.decide({ tool: "get_report", style: "normal" }).allowed).toBe(true);
    expect(named.decide({ tool: "get_report", style: "hacker" })).toMatchObject({ allowed: false, reason: "mutations not allowed" });
    expect(make({ allowTools: ["get_report"], allowMutations: true }).decide({ tool: "get_report", style: "psycho" }).allowed).toBe(true);
  });

  it("a tool that is not in the model is refused", () => {
    expect(make({ allowTools: ["nope"] }).decide({ tool: "nope" })).toMatchObject({ allowed: false, reason: "not in the model" });
  });
});

describe("CLI · mcp-test · guard · --allow-tools is exact names only", () => {
  it.each([[""], [","], ["a,,b"], ["a,"], ["*"], ["all"], ["ALL"], ["All,get_report"], ["get_*"], ["^get"], ["a|b"], ["(a)"], ["re.*"], ["[a-z]+"], ["a\\b"]])(
    "%j is a usage error, not a permission",
    (raw) => {
      expect(() => parseAllowTools(raw)).toThrow(/--allow-tools/);
    },
  );

  it("names are kept exactly: no trimming, no case folding", () => {
    expect(parseAllowTools("get_report,Get_Report, list_items")).toEqual(["get_report", "Get_Report", " list_items"]);
    expect(unknownToolNames(["get_report", "Get_Report", " list_items"], TOOLS)).toEqual(["Get_Report", " list_items"]);
  });

  it("a name that differs by case is not the tool", () => {
    expect(make({ allowTools: ["Get_Report"] }).decide({ tool: "get_report" }).allowed).toBe(false);
  });
});

describe("CLI · mcp-test · guard · names from the server are untrusted (AC-4)", () => {
  it.each([["delete_file"], ["deleteFile"], ["remove-item"], ["видалити_файл"], ["удалить_файл"], ["DeleteFile"], ["purge.cache"], ["logout"], ["resetPassword"]])(
    "%s reads as a deletion",
    (name) => {
      expect(readsDestructive(name)).toBe(true);
    },
  );

  it.each([["get_deleted_report"], ["list_items"], ["getRemovedCount"], ["read_file"], ["search"], ["створити_файл"]])("%s does not", (name) => {
    expect(readsDestructive(name)).toBe(false);
  });

  it("the title counts too", () => {
    expect(assessTools([tool("run_job", { readOnlyHint: true }, { title: "Delete the old jobs" })])[0]).toMatchObject({ destructiveName: true, class: "mutating" });
  });

  it("two tools with the same name are both refused, even when named", () => {
    const g = new McpCallGuard({ tools: [tool("get_report", { readOnlyHint: true }), tool("get_report", { readOnlyHint: true })], allowTools: ["get_report"] });
    expect(g.decide({ tool: "get_report" })).toMatchObject({ allowed: false, reason: "ambiguous name" });
  });

  it("a name that differs only by case or by a look-alike form from another tool makes both ambiguous", () => {
    const g = new McpCallGuard({ tools: [tool("get_report", { readOnlyHint: true }), tool("Get_Report", { readOnlyHint: true })], allowTools: ["get_report"] });
    expect(g.decide({ tool: "get_report" }).reason).toBe("ambiguous name");
    const full = new McpCallGuard({ tools: [tool("get_report", { readOnlyHint: true }), tool("get_report", { readOnlyHint: true })], allowTools: ["get_report"] });
    expect(full.decide({ tool: "Get_Report" }).allowed).toBe(false);
  });

  it("a look-alike (Cyrillic letter) does not pass for the name that was allowed", () => {
    const twin = "get_repоrt"; // Cyrillic o
    const g = new McpCallGuard({ tools: [tool("get_report", { readOnlyHint: true }), tool(twin, { readOnlyHint: true })], allowTools: ["get_report"] });
    expect(twin).not.toBe("get_report");
    expect(g.decide({ tool: twin })).toMatchObject({ allowed: false });
    expect(g.decide({ tool: "get_report" })).toMatchObject({ allowed: true });
  });

  it.each([["get\u0000report"], ["get\u200breport"], ["get\u202ereport"], ["get\nreport"], ["get\u001b[2Jreport"]])("a name with control or invisible characters (%j) is refused even when named", (name) => {
    const g = new McpCallGuard({ tools: [tool(name, { readOnlyHint: true })], allowTools: [name], allowReadOnlyHints: true });
    expect(g.decide({ tool: name })).toMatchObject({ allowed: false, reason: "unsafe name" });
  });

  it("the table prints names without control characters", () => {
    const text = renderProposal(assessTools([tool("a\u001b[2J\nb", { readOnlyHint: true })])).join("\n");
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });
});

describe("CLI · mcp-test · guard · the permission is for what was shown", () => {
  it("a tool the server changed after the user saw it is refused from then on", () => {
    const g = make({ allowTools: ["get_report"] });
    expect(g.decide({ tool: "get_report" }).allowed).toBe(true);
    g.observe(TOOLS.map((t) => (t.name === "get_report" ? { ...t, annotations: { readOnlyHint: false } } : t)));
    expect(g.decide({ tool: "get_report" })).toMatchObject({ allowed: false, reason: "changed since permission" });
    expect(g.report().changed).toEqual(["get_report"]);
  });

  it("a changed description counts too, and a tool that vanished", () => {
    const g = make({ allowTools: ["get_report", "list_items"] });
    g.observe(TOOLS.filter((t) => t.name !== "list_items").map((t) => (t.name === "get_report" ? { ...t, description: "now does something else" } : t)));
    expect(g.decide({ tool: "get_report" }).reason).toBe("changed since permission");
    expect(g.decide({ tool: "list_items" }).reason).toBe("changed since permission");
  });

  it("a list that did not change leaves the permission as it was; a new tool is not in the model", () => {
    const g = make({ allowTools: ["get_report"] });
    g.observe([...TOOLS, tool("brand_new", { readOnlyHint: true })]);
    expect(g.decide({ tool: "get_report" }).allowed).toBe(true);
    expect(g.decide({ tool: "brand_new" }).reason).toBe("not in the model");
  });
});

describe("CLI · mcp-test · guard · budget and rate (AC-6, AC-7)", () => {
  const clock = (): { now: () => number; sleep: (ms: number) => Promise<void>; t: () => number } => {
    let t = 0;
    return { now: () => t, sleep: async (ms) => void (t += ms), t: () => t };
  };

  it("AC-6: --max-calls 3 on 10 calls sends 3, refuses 7 as budget exhausted, exit code 4", async () => {
    const c = clock();
    const g = make({ allowTools: ["get_report"], maxCalls: 3, now: c.now, sleep: c.sleep });
    const decisions = [];
    for (let i = 0; i < 10; i++) decisions.push(await g.admit({ tool: "get_report" }));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    expect(decisions.filter((d) => d.reason === "budget exhausted")).toHaveLength(7);
    expect(g.exitCode()).toBe(4);
    expect(g.report()).toMatchObject({ sent: 3, denied: 7, budgetExhausted: true });
    expect(renderGuardReport(g.report()).join("\n")).toMatch(/not counted as passed/);
  });

  it("AC-6: a retry takes a call of the budget like any other", async () => {
    const c = clock();
    const g = make({ allowTools: ["get_report"], maxCalls: 2, now: c.now, sleep: c.sleep });
    expect((await g.admit({ tool: "get_report" })).allowed).toBe(true);
    expect((await g.admit({ tool: "get_report" })).allowed).toBe(true); // the retry
    expect((await g.admit({ tool: "get_report" })).reason).toBe("budget exhausted");
  });

  it("AC-7: at 2 calls a second the tenth call goes out no earlier than 4.5 s after the first", async () => {
    const c = clock();
    const g = make({ allowTools: ["get_report"], rps: 2, maxCalls: 100, now: c.now, sleep: c.sleep });
    const at: number[] = [];
    for (let i = 0; i < 10; i++) {
      await g.admit({ tool: "get_report" });
      at.push(c.t());
    }
    expect(at[0]).toBe(0);
    expect((at[9] as number) - (at[0] as number)).toBeGreaterThanOrEqual(4500);
  });

  it("slots are reserved at once: concurrent callers queue 1/rps apart", async () => {
    const waits: number[] = [];
    const g = make({ allowTools: ["get_report"], rps: 4, now: () => 0, sleep: async (ms) => void waits.push(ms) });
    await Promise.all([1, 2, 3, 4].map(() => g.admit({ tool: "get_report" })));
    expect(waits).toEqual([250, 500, 750]);
  });

  it("the time budget refuses further calls and ends with exit code 4", async () => {
    let t = 0;
    const g = make({ allowTools: ["get_report"], timeBudgetMs: 1000, now: () => t, sleep: async () => undefined });
    expect((await g.admit({ tool: "get_report" })).allowed).toBe(true);
    t = 1500;
    expect((await g.admit({ tool: "get_report" })).reason).toBe("time budget exhausted");
    expect(g.exitCode()).toBe(4);
  });
});

describe("CLI · mcp-test · guard · the report (AC-9)", () => {
  it("every decision has its reason and no argument values", async () => {
    const g = make({ allowTools: ["get_report"] });
    await g.admit({ tool: "get_report" });
    await g.admit({ tool: "list_items" });
    const r = g.report();
    expect(r.decisions.map((d) => [d.tool, d.allowed, d.reason])).toEqual([
      ["get_report", true, "named in --allow-tools"],
      ["list_items", false, "not allowed"],
    ]);
    for (const d of r.decisions) expect(Object.keys(d).sort()).toEqual(expect.not.arrayContaining(["arguments", "args", "params"]));
  });

  it("the banner is in the report and printed first with --allow-mutations, and absent without it", () => {
    const withIt = make({ allowTools: ["update_item"], allowMutations: true }).report();
    expect(withIt.banner).toBe(MUTATION_BANNER);
    expect(renderGuardReport(withIt)[0]).toContain(MUTATION_BANNER);
    const without = make({ allowTools: ["get_report"] }).report();
    expect(without.banner).toBeUndefined();
    expect(renderGuardReport(without).join("\n")).not.toContain(MUTATION_BANNER);
  });

  it("the proposal lists only read-claimed tools and says it is the server's claim", () => {
    const text = renderProposal(assessTools(TOOLS)).join("\n");
    expect(text).toContain("get_report | read-claimed | yes");
    expect(text).toContain("delete_everything | mutating | no");
    expect(text).toContain("update_item | mutating | no");
    expect(text).toContain("mystery | unknown | no");
    expect(text).toContain("the server's claim, not a check");
  });
});

describe("CLI · mcp-test · the gateway sends only what the guard allows (AC-8)", () => {
  let tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp) {
      try {
        for (const f of readdirSync(d)) unlinkSync(join(d, f));
        rmdirSync(d);
      } catch {
        /* best effort */
      }
    }
    tmp = [];
  });

  const rpcOf = (impl: ToolRpc["invokeTool"]): ToolRpc & { calls: number } => {
    const rpc = {
      calls: 0,
      invokeTool: async (name: string, args: Record<string, unknown>, o: Parameters<ToolRpc["invokeTool"]>[2]) => {
        rpc.calls += 1;
        return impl(name, args, o);
      },
    };
    return rpc;
  };

  it("a refused call never reaches the server and is not logged", async () => {
    const rpc = rpcOf(async () => ({}));
    const logged: unknown[] = [];
    const r = await guardedToolCall(make(), rpc, { tool: "get_report" }, { callTimeoutMs: 1000, log: (e) => void logged.push(e) });
    expect(r).toMatchObject({ sent: false, decision: { allowed: false } });
    expect(rpc.calls).toBe(0);
    expect(logged).toEqual([]);
  });

  it("an allowed call is sent once and logged with the decision, a masked argument and the result", async () => {
    const rpc = rpcOf(async () => ({ content: [] }));
    const logged: Array<Record<string, unknown>> = [];
    const g = make({ allowTools: ["get_report"], sleep: async () => undefined });
    const r = await guardedToolCall(
      g,
      rpc,
      { tool: "get_report", arguments: { id: "r-1", token: "tok-abcdef123", note: "uses hunter2secret here" } },
      { callTimeoutMs: 1000, secrets: ["hunter2secret"], log: (e) => void logged.push({ ...e }) },
    );
    expect(r.sent).toBe(true);
    expect(rpc.calls).toBe(1);
    expect(logged).toHaveLength(1);
    const e = logged[0] as { arguments: string; result: string; reason: string; decision: string; tool: string };
    expect(e).toMatchObject({ tool: "get_report", decision: "allowed", reason: "named in --allow-tools", result: "ok" });
    expect(e.arguments).not.toContain("tok-abcdef123");
    expect(e.arguments).not.toContain("hunter2secret");
    expect(e.arguments).toContain("r-1");
  });

  it.each([
    ["an error result", async () => ({ isError: true }), "error"],
    ["a timeout this side saw", async () => Promise.reject(new LocalFailure("timeout", "t")), "timeout"],
    ["the connection closing, as the transport said", async () => Promise.reject(new LocalFailure("closed", "gone")), "process-exit"],
    ["an answer over the limit", async () => Promise.reject(new LocalFailure("too-large", "big")), "too-large"],
    ["a server's own error with code -32001", async () => Promise.reject(Object.assign(new Error("t"), { code: -32001 })), "error"],
    ["a server's own error with code -32000 and the text Connection closed", async () => Promise.reject(Object.assign(new Error("Connection closed"), { code: -32000 })), "error"],
    ["another failure", async () => Promise.reject(new Error("boom")), "error"],
  ] as const)("%s is logged as %s", async (_label, impl, expected) => {
    const g = make({ allowTools: ["get_report"], sleep: async () => undefined });
    const r = await guardedToolCall(g, rpcOf(impl), { tool: "get_report" }, { callTimeoutMs: 1000 });
    expect(r.sent && r.entry.result).toBe(expected);
  });

  it("the arguments are shortened and nested values do not overflow", () => {
    expect(describeArguments({ text: "x".repeat(2000) }).length).toBeLessThanOrEqual(300);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10_000; i++) deep = { n: deep };
    expect(() => describeArguments(deep)).not.toThrow();
  });

  it("mcp-calls.jsonl gets one line per sent call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-mcp-calls-"));
    tmp.push(dir);
    const g = make({ allowTools: ["get_report"], sleep: async () => undefined });
    const opts = { callTimeoutMs: 1000, log: (e: Parameters<typeof appendCallLog>[1]) => appendCallLog(dir, e) };
    await guardedToolCall(g, rpcOf(async () => ({})), { tool: "get_report" }, opts);
    await guardedToolCall(g, rpcOf(async () => ({})), { tool: "list_items" }, opts); // refused: not logged
    const lines = readFileSync(join(dir, CALL_LOG_FILE), "utf8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ tool: "get_report", result: "ok" });
  });

  it("no code in src/mcp-test can send a call except the gateway", () => {
    const dir = resolve(here, "..", "..", "src", "mcp-test");
    const withCall = readdirSync(dir).filter((f) => /tools\/call|callTool|CallToolRequest/.test(readFileSync(join(dir, f), "utf8")));
    expect(withCall).toEqual(["call.ts"]);
    const gateway = readFileSync(join(dir, "call.ts"), "utf8");
    expect(gateway.match(/tools\/call/g)).toHaveLength(1);
    // The connection hands out lists and a close, not the client that could send.
    expect(readFileSync(join(dir, "connect.ts"), "utf8")).not.toMatch(/client:\s|getClient|rpc/);
  });
});

describe("CLI · mcp-test · the command (AC-1, AC-9, flags)", () => {
  let tmp: string[] = [];
  let out: string[];
  let err: string[];
  const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };
  beforeEach(() => {
    out = [];
    err = [];
  });
  afterEach(() => {
    for (const d of tmp) {
      try {
        for (const f of readdirSync(d)) unlinkSync(join(d, f));
        rmdirSync(d);
      } catch {
        /* best effort */
      }
    }
    tmp = [];
    process.exitCode = 0;
    vi.unstubAllEnvs();
  });
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "cairn-mcp-guard-"));
    tmp.push(d);
    return d;
  };
  const run = async (extra: Record<string, unknown> = {}) => {
    const o = dir();
    const callLog = join(o, "calls-received.txt");
    const r = await runMcpTest(
      { command: [process.execPath, fixture], out: o, env: ["FIXTURE_GUARD=1", `FIXTURE_CALL_LOG=${callLog}`], timeout: 20, ...extra },
      io,
    );
    return { r, o, callLog };
  };

  it("AC-1: by default nothing reaches the server and the table of proposals is printed", async () => {
    const { r, o, callLog } = await run();
    expect(r.exitCode).toBe(0); // reading the server is still a success; no call was asked for
    expect(existsSync(callLog)).toBe(false);
    expect(existsSync(join(o, CALL_LOG_FILE))).toBe(false);
    const text = out.join("");
    expect(text).toMatch(/get_report \| read-claimed \| yes/);
    expect(text).toMatch(/delete_everything \| mutating \| no/);
    expect(text).toMatch(/the server's claim, not a check/);
  });

  it("AC-1: asking for calls sends them through the runner, only for the named tool, and the guard report counts them", async () => {
    const { o, callLog } = await run({ allowTools: "get_report" });
    expect(err.join("")).not.toMatch(/No tool call was sent/);
    const called = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
    expect(called.length).toBeGreaterThan(0);
    expect(new Set(called)).toEqual(new Set(["get_report"]));
    expect(existsSync(join(o, CALL_LOG_FILE))).toBe(true);
    const report = JSON.parse(readFileSync(join(o, "mcp-guard.json"), "utf8")) as { sent: number; policy: { allowTools: string[] } };
    expect(report.sent).toBe(called.length);
    expect(report.policy.allowTools).toEqual(["get_report"]);
  });

  it("--allow-mutations alone is not a permission and says so", async () => {
    const { r } = await run({ allowMutations: true });
    expect(r.exitCode).toBe(5);
    expect(out.join("")).toMatch(/allows nothing/);
  });

  it("AC-9: the banner is printed and saved with --allow-mutations, and neither without it", async () => {
    const withIt = await run({ allowMutations: true, allowTools: "update_item" });
    expect(out.join("")).toContain(MUTATION_BANNER);
    expect(readFileSync(join(withIt.o, "mcp-guard.json"), "utf8")).toContain(MUTATION_BANNER);
    out = [];
    const without = await run({ allowTools: "get_report" });
    expect(out.join("")).not.toContain(MUTATION_BANNER);
    expect(readFileSync(join(without.o, "mcp-guard.json"), "utf8")).not.toContain(MUTATION_BANNER);
  });

  it("a name the server does not have is an error (exit 1), not a silent skip", async () => {
    const { r } = await run({ allowTools: "get_report,Get_Report" });
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toMatch(/does not have: "Get_Report"/);
  });

  it.each([["*"], ["all"], [""], ["get_*"]])("--allow-tools %j is refused before anything connects", async (raw) => {
    await expect(runMcpTest({ command: [process.execPath, fixture], allowTools: raw }, io)).rejects.toThrow(/--allow-tools/);
  });

  it.each([
    [{ maxCalls: "0" }, /--max-calls/],
    [{ rps: "0" }, /--rps/],
    [{ callTimeout: "abc" }, /--call-timeout/],
    [{ timeBudget: "-1" }, /--time-budget/],
  ] as const)("a bad limit %j is a usage error", async (flags, message) => {
    await expect(runMcpTest({ command: [process.execPath, fixture], ...flags }, io)).rejects.toThrow(message);
  });
});
