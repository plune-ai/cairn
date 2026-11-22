import { afterEach, describe, expect, it, vi } from "vitest";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProposals, renderProposedYaml, type RawProposal } from "../../src/mcp-test/scenarios.js";
import { runMcpTest } from "../../src/mcp-test/run.js";
import type { McpToolEntry } from "../../src/mcp-test/model.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";

/**
 * `cairn mcp-test --propose-scenarios`: the model proposes agent scenarios, the code checks each one against the model of
 * the server, and only what passes is written, every scenario `proposed: true` and `disabled: true`. No test here calls a
 * paid model: the model is a scripted `StructuredInvoke`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-runner-server.mjs");
const modelFixture = resolve(here, "..", "fixtures", "mcp-model-server.mjs");

const TOOLS: McpToolEntry[] = [
  { name: "notes_search", description: "Searches notes by words.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { name: "note_create", description: "Creates a note.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] }, annotations: { readOnlyHint: false } },
  { name: "note_delete", description: "Deletes a note.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { destructiveHint: true } },
];

const pos = (over: Partial<RawProposal> = {}): RawProposal => ({ id: "find-budget", description: "Searching notes by a subject.", prompt: "Find my notes about the quarterly budget.", kind: "positive", tool: "notes_search", ...over });
const neg = (over: Partial<RawProposal> = {}): RawProposal => ({ id: "weather", description: "A question outside the server's domain calls no tool.", prompt: "What will the weather be tomorrow?", kind: "negative", ...over });

describe("CLI · mcp-test · propose · checks", () => {
  it("a proposal naming a tool the server does not have is rejected with the reason and is not kept", () => {
    const r = checkProposals([pos(), pos({ id: "ghost", tool: "notes_ghost", prompt: "Show me the ghost list." })], TOOLS);
    expect(r.accepted.map((s) => s.id)).toEqual(["find-budget"]);
    expect(r.rejected).toEqual([{ id: "ghost", reason: expect.stringMatching(/does not have/) }]);
  });

  it("a negative scenario that forbids an unknown tool is rejected too", () => {
    const r = checkProposals([neg({ id: "x", forbiddenTool: "nope" })], TOOLS);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/does not have/);
  });

  it("partial arguments that do not fit the inputSchema are rejected; fitting partial arguments are kept", () => {
    const r = checkProposals([pos({ args: '{"limit": 0}' }), pos({ id: "ok", prompt: "Find five notes on tax.", args: '{"limit": 5}' }), pos({ id: "junk", prompt: "Find tax notes.", args: "not json" })], TOOLS);
    expect(r.accepted.map((s) => s.id)).toEqual(["ok"]);
    expect(r.accepted[0]?.args).toEqual({ limit: 5 });
    expect(r.rejected.map((x) => x.id)).toEqual(["find-budget", "junk"]);
    expect(r.rejected[0]?.reason).toMatch(/inputSchema/);
  });

  it("a call of a tool that may change data is kept only with the explicit mark", () => {
    const r = checkProposals([pos({ id: "a", tool: "note_create", prompt: "Write down a note titled Groceries." }), pos({ id: "b", tool: "note_create", prompt: "Write down a note titled Errands.", changesData: true })], TOOLS);
    expect(r.accepted.map((s) => s.id)).toEqual(["b"]);
    expect(r.rejected[0]?.reason).toMatch(/change data/);
  });

  it("a prompt that repeats the tool name is rejected (it would test word matching only)", () => {
    const r = checkProposals([pos({ prompt: "Run notes_search for budget." })], TOOLS);
    expect(r.rejected[0]?.reason).toMatch(/tool name/);
  });

  it("a prompt or arguments too long for the review queue are rejected, not cut", () => {
    const r = checkProposals([pos({ prompt: `Find notes about ${"tax ".repeat(100)}` }), pos({ id: "big", prompt: "Find big notes.", args: JSON.stringify({ query: "q".repeat(1200) }) })], TOOLS);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/longer than 380/), expect.stringMatching(/longer than 1000/)]);
  });

  it("a scenario already in plune.yaml is not proposed again (same id, or the same prompt plain or quoted)", () => {
    const existing = 'evals:\n  - id: other\n    prompt: "Find my notes about the quarterly   budget."\n  - id: weather\n    prompt: x\n';
    const r = checkProposals([pos(), neg(), neg({ id: "sunny", prompt: "Is it sunny?" })], TOOLS, existing);
    expect(r.accepted.map((s) => s.id)).toEqual(["sunny"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["already in plune.yaml", "already in plune.yaml"]);
  });

  it("an id or prompt that only starts like one in plune.yaml is still proposed", () => {
    const existing = "evals:\n  - id: find-budget-old\n    prompt: Find my notes about the quarterly budget and the tax.\n    description: Find my notes about the quarterly budget.\n";
    expect(checkProposals([pos()], TOOLS, existing).accepted.map((s) => s.id)).toEqual(["find-budget"]);
  });

  it("two proposals with the same request keep only the first (the review queue would drop the second)", () => {
    const r = checkProposals([pos(), pos({ id: "again", prompt: "find my notes about the  quarterly budget.", args: '{"limit": 2}' })], TOOLS);
    expect(r.accepted.map((s) => s.id)).toEqual(["find-budget"]);
    expect(r.rejected[0]?.reason).toMatch(/same request/);
  });

  it("the YAML marks every scenario proposed and disabled, quotes model text, and has a negative one", () => {
    const { accepted } = checkProposals([pos({ description: "x\nproposed: false # injected" }), neg(), neg({ id: "no-delete", prompt: "Tidy my notes up.", forbiddenTool: "note_delete" })], TOOLS);
    const yaml = renderProposedYaml("notes", accepted);
    const evals = yaml.split("\n  - id:").slice(1);
    expect(evals).toHaveLength(3);
    for (const e of evals) {
      expect(e).toContain("\n    proposed: true\n");
      expect(e).toContain("\n    disabled: true\n");
    }
    expect(yaml).not.toMatch(/^\s*proposed: false/m);
    expect(yaml).toContain("type: only-tools");
    expect(yaml).toContain("type: tool-not-called");
  });
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  process.exitCode = 0;
});

/** A scripted model: answers with the given proposals and records what it was sent. */
function scripted(proposals: RawProposal[]) {
  const sent: string[] = [];
  const invoke: StructuredInvoke = async (schema, messages) => {
    sent.push(JSON.stringify(messages));
    // As a strict provider answers: every key present, null where there is no value.
    return schema.parse({ scenarios: proposals.map((p) => ({ tool: null, args: null, forbiddenTool: null, changesData: null, ...p })) });
  };
  return { invoke, sent };
}

async function runIt(propose: { invoke: StructuredInvoke } | undefined, extra: Record<string, unknown> = {}) {
  const work = mkdtempSync(join(tmpdir(), "cairn-propose-"));
  dirs.push(work);
  const o = join(work, "run");
  const log = join(work, "calls.log");
  const out: string[] = [];
  const err: string[] = [];
  const r = await runMcpTest(
    { command: [process.execPath, fixture], out: o, env: [`FIXTURE_LOG=${log}`, "SECRET_TOKEN=s3cr3t-value-123"], timeout: 20, proposeScenarios: true, ...extra, ...(propose ? { propose: { ...propose, cost: () => ({ perRole: [], totalTokens: 1234, totalCostUsd: 0.0123 }) } } : {}) },
    { out: (s) => void out.push(s), err: (s) => void err.push(s) },
  );
  return { r, o, work, log, out: out.join(""), err: err.join("") };
}

describe("CLI · mcp-test · propose · command", () => {
  it("writes the proposals file and a review-queue artifact, leaves plune.yaml as it was, and sends no tool call", async () => {
    const model = scripted([
      { id: "echo-hello", description: "Echoing a word.", prompt: "Repeat the word hello back to me.", kind: "positive", tool: "echo", args: '{"q": "hello"}' },
      { id: "ghost", description: "A tool that is not there.", prompt: "Open the vault.", kind: "positive", tool: "vault_open" },
      { id: "weather", description: "Outside the domain.", prompt: "What will the weather be tomorrow?", kind: "negative" },
    ]);
    const work = mkdtempSync(join(tmpdir(), "cairn-propose-cwd-"));
    dirs.push(work);
    const planFile = join(work, "plune.yaml");
    writeFileSync(planFile, "version: 1\nevals: []\n", "utf8");
    const hash = (): string => createHash("sha256").update(readFileSync(planFile)).digest("hex");
    const before = hash();
    const { r, o, log, out } = await runIt(model, { pluneConfig: planFile });
    expect(r.exitCode).toBe(0);
    expect(hash()).toBe(before);
    // Cairn runs nothing: the server got no tools/call, and the model was asked once.
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    expect(model.sent).toHaveLength(1);
    const yaml = readFileSync(join(o, "plune.mcp-scenarios.proposed.yaml"), "utf8");
    expect(yaml).toContain('"echo-hello"');
    expect(yaml).not.toContain("vault_open");
    const summary = JSON.parse(readFileSync(join(o, "mcp-scenarios.json"), "utf8")) as { rejected: Array<{ id: string; reason: string }>; cost: { totalCostUsd: number } };
    expect(summary.rejected.map((x) => x.id)).toEqual(["ghost"]);
    expect(summary.cost.totalCostUsd).toBe(0.0123);
    // The review queue: an mcp-kind artifact `plune ingest` reads, one proposal per scenario, none with a verdict.
    const report = JSON.parse(readFileSync(join(o, "scenarios", "report.json"), "utf8")) as { schemaVersion: number; mode: string; testCases: Array<{ stableId: string; title: string; steps: string[]; expected: string; verdict?: string }> };
    expect(report).toMatchObject({ schemaVersion: 1, mode: "mcp" });
    expect(report.testCases).toHaveLength(2);
    for (const c of report.testCases) {
      expect(c.stableId).toMatch(/^[0-9a-f]{12}$/);
      expect(c.verdict).toBeUndefined();
    }
    expect(out).toMatch(/\$0\.0123/);
  });

  it("starts no process but the server: plune run is never called", async () => {
    // Every way Node starts a process goes through this module: the SDK's stdio transport (cross-spawn) and any import of it.
    const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
    const spies = names.map((n) => vi.spyOn(childProcess, n));
    syncBuiltinESMExports();
    try {
      const model = scripted([
        { id: "echo-hello", description: "Echoing a word.", prompt: "Repeat the word hello back to me.", kind: "positive", tool: "echo" },
        { id: "weather", description: "Outside the domain.", prompt: "What will the weather be tomorrow?", kind: "negative" },
      ]);
      const { r } = await runIt(model);
      expect(r.exitCode).toBe(0);
      const started = spies.flatMap((s) => s.mock.calls.map((c) => [c[0], ...(Array.isArray(c[1]) ? c[1] : [])].map(String)));
      // The server itself was started (the spy sees it), and nothing that is not the server or its reaping on Windows.
      expect(started.some((argv) => argv.includes(fixture))).toBe(true);
      const others = started.filter((argv) => !argv.includes(fixture) && argv[0] !== "taskkill");
      expect(others).toEqual([]);
      // In particular no `plune` (the CLI or `npx @plune-ai/cli`): Cairn proposes scenarios and runs none of them.
      expect(started.filter((argv) => argv.some((a) => /^plune(\.cmd|\.exe)?$/i.test(basename(a)) || a.startsWith("@plune-ai/cli")))).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("without --propose-scenarios no model is asked, nothing is proposed and the cost is 0", async () => {
    const model = scripted([]);
    const { r, o } = await runIt(model, { proposeScenarios: false });
    expect(r.exitCode).toBe(0);
    expect(model.sent).toHaveLength(0);
    expect(existsSync(join(o, "plune.mcp-scenarios.proposed.yaml"))).toBe(false);
  });

  it("without a model provider it says why and connects to nothing", async () => {
    await expect(runIt(undefined)).rejects.toThrow(/--propose-scenarios needs a model provider/);
  });

  it("a secret of the run does not reach the model or the files", async () => {
    const model = scripted([{ id: "leak", description: "Uses s3cr3t-value-123.", prompt: "Repeat s3cr3t-value-123 to me.", kind: "positive", tool: "ping" }]);
    // This server puts the value of SECRET_TOKEN into the description of `ping`, as a leaky server would.
    const { o } = await runIt(model, { command: [process.execPath, modelFixture], env: ["SECRET_TOKEN=s3cr3t-value-123", "FIXTURE_ECHO_ENV=SECRET_TOKEN"] });
    expect(model.sent).toHaveLength(1);
    expect(model.sent.join("")).toContain("pong");
    expect(model.sent.join("")).not.toContain("s3cr3t-value-123");
    for (const f of ["plune.mcp-scenarios.proposed.yaml", "mcp-scenarios.json", join("scenarios", "report.json")]) {
      expect(readFileSync(join(o, f), "utf8")).not.toContain("s3cr3t-value-123");
    }
  });

  it("a server with two or more tools and no negative proposal left fails the run (exit 1), the file is still written", async () => {
    const model = scripted([{ id: "echo-hello", description: "Echo.", prompt: "Say hello back.", kind: "positive", tool: "echo" }]);
    const { r, o, err } = await runIt(model);
    expect(r.exitCode).toBe(1);
    expect(err).toMatch(/no negative scenario/);
    expect(existsSync(join(o, "plune.mcp-scenarios.proposed.yaml"))).toBe(true);
  });

  it("two runs into the same --out get different run ids; the scenarios report of a run is its check report id plus -scenarios", async () => {
    const work = mkdtempSync(join(tmpdir(), "cairn-propose-same-out-"));
    dirs.push(work);
    const same = join(work, "mcp-run");
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const model = scripted([
        { id: "echo-hello", description: "Echoing a word.", prompt: "Repeat the word hello back to me.", kind: "positive", tool: "echo", args: '{"q": "hello"}' },
        { id: "weather", description: "Outside the domain.", prompt: "What will the weather be tomorrow?", kind: "negative" },
      ]);
      await runIt(model, { out: same, allowTools: "echo", maxCalls: 50 });
      const check = JSON.parse(readFileSync(join(same, "report.json"), "utf8")) as { runId: string };
      const scenarios = JSON.parse(readFileSync(join(same, "scenarios", "report.json"), "utf8")) as { runId: string };
      expect(check.runId).not.toBe(basename(same));
      expect(scenarios.runId).toBe(`${check.runId}-scenarios`);
      ids.push(check.runId);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});
