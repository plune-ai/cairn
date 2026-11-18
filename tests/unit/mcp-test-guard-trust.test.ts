import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardUsageError, McpCallGuard, READ_VERBS, assessTools, renderProposal } from "../../src/mcp-test/guard.js";
import { describeArguments } from "../../src/mcp-test/call.js";
import { safeText, type McpToolEntry } from "../../src/mcp-test/model.js";
import { runMcpTest } from "../../src/mcp-test/run.js";

/**
 * MCP-E4 review fixes. The trust flag (`--allow-read-only-hints`) rests on an allow-list, not on a list of bad words:
 * a tool is allowed on the server's claim only when the claim is `readOnlyHint: true`, the server does not also say
 * `destructiveHint`, the name is plain ASCII, its first word is a read verb, and the deletion words find nothing in the
 * name or title. Everything else needs its exact name in --allow-tools.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-model-server.mjs");

const ro = (name: string, extra: Partial<McpToolEntry> = {}, hints: Record<string, unknown> = {}): McpToolEntry => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true, ...hints },
  ...extra,
});

// A Cyrillic "е" in place of the Latin one.
const LOOKALIKE = `d${String.fromCharCode(0x435)}lete_file`;

/** Names a deny-list of words does not see as harmful. Each claims read-only here. */
const HARMLESS_LOOKING = [
  "destroy", "erase", "truncate", "rm", "rmdir", "revoke", "unlink", "kill", "send_email", "pay", "transfer", "refund",
  "charge", "publish", "deploy", "shutdown", "format_disk", "overwrite", "run_sql", "exec", "execute", "ban_user",
  "disable_account", "unsubscribe", "deletefile", "removeall", "delete2", LOOKALIKE,
];

describe("CLI · mcp-test · guard · the trust flag is an allow-list", () => {
  it("the read verbs are one exported list", () => {
    expect([...READ_VERBS].sort()).toEqual(["check", "count", "describe", "fetch", "find", "get", "list", "lookup", "query", "read", "search", "show", "status", "view"]);
  });

  it.each(HARMLESS_LOOKING.map((n) => [n]))("%s, claimed read-only, is not allowed on the claim and not proposed", (name) => {
    const tools = [ro(name)];
    expect(assessTools(tools)[0]).toMatchObject({ proposed: false });
    expect(assessTools(tools)[0]?.class).not.toBe("read-claimed");
    const g = new McpCallGuard({ tools, allowReadOnlyHints: true });
    expect(g.decide({ tool: name }).allowed).toBe(false);
  });

  it.each(HARMLESS_LOOKING.map((n) => [n]))("%s is allowed only when its exact name is given", (name) => {
    const tools = [ro(name)];
    expect(new McpCallGuard({ tools, allowTools: [name] }).decide({ tool: name })).toMatchObject({ allowed: true, basis: "named" });
    // the trust flag next to the name changes nothing
    expect(new McpCallGuard({ tools, allowTools: ["other"], allowReadOnlyHints: true }).decide({ tool: name }).allowed).toBe(false);
  });

  it.each([["get_report"], ["list_items"], ["search-users"], ["GetReport"], ["read.file"], ["status"], ["count_items"], ["fetch-data"], ["describe_table"], ["lookup_user"]])(
    "%s is allowed on the claim",
    (name) => {
      const tools = [ro(name)];
      expect(assessTools(tools)[0]).toMatchObject({ class: "read-claimed", proposed: true });
      expect(new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: name })).toMatchObject({ allowed: true, basis: "server-claim" });
    },
  );

  it("get_deleted_report: the deletion words do not see 'deleted', so it is allowed on the claim (pinned)", () => {
    const tools = [ro("get_deleted_report")];
    expect(new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: "get_deleted_report" }).allowed).toBe(true);
  });

  it("a name with a non-ASCII letter is not allowed on the claim, even with a read verb", () => {
    const name = `get_caf${String.fromCharCode(0xe9)}`;
    const tools = [ro(name)];
    expect(new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: name }).allowed).toBe(false);
    expect(renderProposal(assessTools(tools)).join(" ")).toMatch(/name has characters outside/);
  });

  it("a read verb is not enough: destructiveHint, a missing hint, or a deleting title each stop it", () => {
    const stop = (t: McpToolEntry): boolean => new McpCallGuard({ tools: [t], allowReadOnlyHints: true }).decide({ tool: t.name }).allowed;
    expect(stop(ro("get_x", {}, { destructiveHint: true }))).toBe(false);
    expect(stop({ name: "get_x", inputSchema: {} })).toBe(false);
    expect(stop(ro("get_x", { title: "Delete the old jobs" }))).toBe(false);
    expect(stop(ro("delete_x"))).toBe(false);
  });

  it("the description is free text and stays out of the decision", () => {
    const tools = [ro("get_x", { description: "Deletes every record and sends them by e-mail." })];
    expect(new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: "get_x" }).allowed).toBe(true);
  });

  it("a tool that claims read-only but fails the name rule is shown with the reason, and is not in the proposal", () => {
    const text = renderProposal(assessTools([ro("get_report"), ro("send_email")])).join("\n");
    expect(text).toContain("send_email | unknown | no (claims read-only; name does not start with a read verb)");
    expect(text).toContain("get_report | read-claimed | yes");
    expect(text).toMatch(/Proposed with --allow-read-only-hints or by name in --allow-tools: get_report\./);
    expect(text).not.toMatch(/Proposed[^\n]*send_email/);
  });

  it("a tool that was classed mutating before is still mutating: its name alone is not enough", () => {
    const tools = [ro("delete_x")];
    expect(new McpCallGuard({ tools, allowTools: ["delete_x"] }).decide({ tool: "delete_x" }).allowed).toBe(false);
    expect(new McpCallGuard({ tools, allowTools: ["delete_x"], allowMutations: true }).decide({ tool: "delete_x" }).allowed).toBe(true);
  });
});

describe("CLI · mcp-test · guard · a prefix shared by every tool name", () => {
  const trusted = (tools: McpToolEntry[], name: string): boolean => new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: name }).allowed;
  const PREFIXED = [ro("plune_get"), ro("plune_list_runs"), ro("plune-search"), ro("pluneShowRun"), ro("plune_mission_get"), ro("plune_send_report"), ro("plune_run_sql")];

  it.each([["plune_get"], ["plune_list_runs"], ["plune-search"], ["pluneShowRun"]])("%s: a read verb after the shared prefix is allowed on the claim", (name) => {
    expect(assessTools(PREFIXED).find((a) => a.name === name)).toMatchObject({ class: "read-claimed", proposed: true });
    expect(trusted(PREFIXED, name)).toBe(true);
  });

  it.each([["plune_send_report"], ["plune_run_sql"], ["plune_mission_get"]])("%s: no read verb right after the shared prefix is refused on the claim", (name) => {
    expect(assessTools(PREFIXED).find((a) => a.name === name)).toMatchObject({ class: "unknown", proposed: false });
    expect(trusted(PREFIXED, name)).toBe(false);
  });

  it("the prefix is shown in the reason of a refused tool", () => {
    expect(renderProposal(assessTools(PREFIXED)).join("\n")).toContain('plune_send_report | unknown | no (claims read-only; name has no read verb after the shared prefix "plune")');
  });

  it("a prefix that only some tools share is not skipped: those tools are judged as before", () => {
    const tools = [ro("plune_get"), ro("plune_list"), ro("get_report")];
    expect(trusted(tools, "plune_get")).toBe(false);
    expect(trusted(tools, "get_report")).toBe(true);
  });

  it("one tool alone has no shared prefix", () => {
    expect(trusted([ro("plune_get")], "plune_get")).toBe(false);
  });

  it("a prefix that is itself a read verb changes nothing", () => {
    const tools = [ro("get_report"), ro("get_send_mail")];
    expect(trusted(tools, "get_report")).toBe(true);
    expect(trusted(tools, "get_send_mail")).toBe(true); // as before the prefix rule: the first word is a read verb
  });

  it("a deleting name stays mutating after the prefix", () => {
    const tools = [ro("plune_get"), ro("plune_delete_run")];
    expect(trusted(tools, "plune_delete_run")).toBe(false);
    expect(assessTools(tools)[1]?.class).toBe("mutating");
  });
});

describe("CLI · mcp-test · guard · a name that joins actions", () => {
  const JOINED = ["show_and_send_email", "fetch_and_execute", "get_or_create_user", "list_then_tag", "readThenWrite", "plune_get_and_send"];

  it.each(JOINED.map((n) => [n]))("%s is not allowed on the claim, and the reason says why", (name) => {
    const tools = name.startsWith("plune") ? [ro(name), ro("plune_get")] : [ro(name)];
    const a = assessTools(tools).find((x) => x.name === name);
    expect(a).toMatchObject({ class: "unknown", proposed: false, claimClean: true });
    expect(a?.claimNote).toMatch(/joins actions/);
    expect(new McpCallGuard({ tools, allowReadOnlyHints: true }).decide({ tool: name })).toMatchObject({ allowed: false, reason: "claim not trusted" });
  });

  it.each(JOINED.map((n) => [n]))("%s is allowed by its exact name in --allow-tools", (name) => {
    const tools = [ro(name)];
    expect(new McpCallGuard({ tools, allowTools: [name], allowReadOnlyHints: true }).decide({ tool: name })).toMatchObject({ allowed: true, basis: "named" });
  });

  it.each([["get_order"], ["list_vendors"], ["show_brand"], ["get_android_info"], ["fetch_theme"]])("%s: a word that only contains a conjunction does not count", (name) => {
    expect(new McpCallGuard({ tools: [ro(name)], allowReadOnlyHints: true }).decide({ tool: name }).allowed).toBe(true);
  });
});

describe("CLI · mcp-test · guard · limits are numbers", () => {
  it.each([
    [{ maxCalls: Number.NaN }, /max-calls/],
    [{ maxCalls: 0 }, /max-calls/],
    [{ maxCalls: -1 }, /max-calls/],
    [{ maxCalls: Number.POSITIVE_INFINITY }, /max-calls/],
    [{ rps: Number.NaN }, /rps/],
    [{ rps: 0 }, /rps/],
    [{ timeBudgetMs: Number.NaN }, /time budget/],
    [{ timeBudgetMs: -5 }, /time budget/],
  ] as const)("%j is refused", (opts, message) => {
    expect(() => new McpCallGuard({ tools: [], ...opts })).toThrow(GuardUsageError);
    expect(() => new McpCallGuard({ tools: [], ...opts })).toThrow(message);
  });

  it("good numbers are accepted", () => {
    expect(() => new McpCallGuard({ tools: [], maxCalls: 1, rps: 0.5, timeBudgetMs: 1 })).not.toThrow();
  });
});

describe("CLI · mcp-test · printed text", () => {
  it("bidi and zero-width characters are removed from what is printed", () => {
    const chars = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
    for (const c of chars) {
      const s = safeText(`a${String.fromCharCode(c)}b`);
      expect(s, c.toString(16)).not.toContain(String.fromCharCode(c));
      expect(s).toMatch(/^a\s?b$/);
    }
    expect(renderProposal(assessTools([ro(`get${String.fromCharCode(0x202e)}tros`)])).join("")).not.toContain(String.fromCharCode(0x202e));
  });

  it("describeArguments does not cut a surrogate pair at the limit", () => {
    for (const pad of ["", "a"]) {
      const text = describeArguments({ t: pad + String.fromCodePoint(0x1f600).repeat(400) });
      expect(Array.from(text).length).toBeLessThanOrEqual(300);
      expect(text, `pad "${pad}"`).toBe(Buffer.from(text, "utf8").toString("utf8")); // a lone half would come back as U+FFFD
    }
  });
});

describe("CLI · mcp-test · only one door sends a call", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
    });

  it("across all of src, the call method name and callTool( appear in call.ts only", () => {
    const src = resolve(here, "..", "..", "src");
    const found = walk(src)
      .filter((f) => /tools\/call|callTool\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(src.length + 1).replace(/\\/g, "/"));
    expect(found).toEqual(["mcp-test/call.ts"]);
  });

  it("the low-level SDK request method is used in the connection module only, and the connection has no generic sender", () => {
    const dir = resolve(here, "..", "..", "src", "mcp-test");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const text = (f: string): string => readFileSync(join(dir, f), "utf8");
    // `.request(` is the SDK's raw sender (and a runner's link must not have one under that name).
    expect(files.filter((f) => /\.request\(/.test(text(f)))).toEqual(["connect.ts"]);
    // The connection offers a method by name for a tool call and no method that takes a method name.
    expect(text("connect.ts")).not.toMatch(/request\s*:\s*\(?\s*req|request\(req/);
    // A call goes through invokeTool( in call.ts only (the connection defines it, the gateway calls it).
    expect(files.filter((f) => /\.invokeTool\(/.test(text(f)))).toEqual(["call.ts"]);
  });
});

describe("CLI · mcp-test · the report is written on every read", () => {
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

  it("mcp-guard.json and the hint/name disagreements exist without any --allow flag", async () => {
    const o = mkdtempSync(join(tmpdir(), "cairn-mcp-trust-"));
    tmp.push(o);
    const out: string[] = [];
    const r = await runMcpTest({ command: [process.execPath, fixture], out: o, env: ["FIXTURE_GUARD=1"], timeout: 20 }, { out: (s) => void out.push(s), err: () => undefined });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(o, "mcp-guard.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(o, "mcp-guard.json"), "utf8")) as { sent: number; mismatches: Array<{ tool: string }> };
    expect(report.sent).toBe(0);
    expect(report.mismatches.map((m) => m.tool)).toEqual(["delete_everything"]);
    expect(out.join("")).toMatch(/Hint and name disagree[\s\S]*delete_everything/);
  });
});
