import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_KINDS, proposeVariants, readEval, readRecording, renderProposedYaml, runProposeFailures, type RecordedStub } from "../../src/failure-variants/index.js";

/**
 * `cairn propose-failures`: variants of one eval of `plune.yaml` under a provider failure. The answer after the failure is
 * the one recorded with `plune mock --record`; no model is called and no answer is written by Cairn. The recording below
 * is one the recorder of the CLI wrote: comment lines, then JSON.
 */
const PLAN = [
  "version: 1",
  "provider:",
  "  model: example-model-1",
  "evals:",
  "  - id: other",
  "    prompt: hi",
  "    dataset: { examples: [{ vars: {} }] }",
  "    assertions: []",
  "",
  "  # the refund question",
  "  - id: refund-answer",
  "    description: The refund question gets an approval.",
  '    prompt: "Can order {{order}} be refunded?"',
  "    dataset:",
  "      examples:",
  "        - vars: { order: 1042 }",
  "    assertions:",
  "      - type: contains",
  '        value: "Refund approved"',
  "judge:",
  "  model: x",
  "",
].join("\n");

const answer = (over: Record<string, unknown> = {}): RecordedStub => ({
  method: "POST",
  times: "always",
  path: "/v1/messages",
  body: { model: "example-model-1", max_tokens: 1024, messages: [{ role: "user", content: "Can order 1042 be refunded?" }] },
  match: "exact",
  response: { status: 200, headers: { "content-type": "application/json" }, json: { type: "message", content: [{ type: "text", text: "Refund approved for order 1042." }] } },
  ...over,
});
const recording = (stubs: unknown[]): string => `# Recorded by \`plune mock --record\` on 2026-11-25 from http://127.0.0.1:4310\n# Keep this file local.\n${JSON.stringify({ version: 1, stubs }, null, 2)}\n`;

describe("CLI · propose-failures · reading", () => {
  it("finds the eval as written, with the provider it runs on (the root one, overridden by its own)", () => {
    const e = readEval(PLAN, "refund-answer");
    expect(e.block[0]).toBe("  - id: refund-answer");
    expect(e.block.at(-1)).toBe('        value: "Refund approved"');
    expect(e.provider).toEqual({ model: "example-model-1" });
    const own = readEval(PLAN.replace("    description: The refund", "    provider: { model: other-model, timeout: 5000, max_retries: 1 }\n    description: The refund"), "refund-answer");
    expect(own.provider).toEqual({ model: "other-model", timeout: 5000, maxRetries: 1 });
  });

  it("refuses an id that is not there, an id that is not a slug, and an eval with mcp", () => {
    expect(() => readEval(PLAN, "nope")).toThrow(/no eval "nope"/);
    expect(() => readEval(PLAN, "Bad Id")).toThrow(/lowercase/);
    expect(() => readEval(PLAN.replace("    description: The refund", "    mcp: { server: notes }\n    description: The refund"), "refund-answer")).toThrow(/mcp/);
  });

  it("reads a recording (comment lines, then JSON) and refuses anything else without printing its text", () => {
    expect(readRecording(recording([answer()]))).toHaveLength(1);
    let message = "";
    try {
      readRecording("version: 1\nstubs:\n  - path: /v1/messages\n    secret: s3cr3t\n");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/plune mock --record/);
    expect(message).not.toContain("s3cr3t");
    expect(() => readRecording(JSON.stringify({ version: 2, stubs: [] }))).toThrow(/version: 1/);
  });
});

describe("CLI · propose-failures · variants", () => {
  const ev = readEval(PLAN, "refund-answer");

  it("proposes one variant per failure kind, each the recorded answer with the failure added and nothing else changed", () => {
    const r = proposeVariants(ev, [answer()], FAILURE_KINDS, PLAN);
    expect(r.accepted.map((v) => v.id)).toEqual(["refund-answer-http-500", "refund-answer-http-429", "refund-answer-reset", "refund-answer-slow-stream", "refund-answer-truncated-json"]);
    // No provider.timeout: `plune run` refuses a timeout stub, so it is not proposed.
    expect(r.rejected).toEqual([{ id: "refund-answer-timeout", reason: expect.stringMatching(/provider\.timeout/) }]);
    const byKind = Object.fromEntries(r.accepted.map((v) => [v.failure.type, v]));
    expect(byKind["http_500"]?.failure).toEqual({ type: "http_500", first: 2 });
    expect(byKind["http_429"]?.failure).toEqual({ type: "http_429", first: 1, retry_after_seconds: 1 });
    expect(byKind["reset"]?.failure).toEqual({ type: "reset", first: 1 });
    expect(byKind["slow_stream"]?.failure).toEqual({ type: "slow_stream", bytes_per_sec: 256 });
    expect(byKind["truncated_json"]?.failure).toEqual({ type: "truncated_json" });
    for (const v of r.accepted) {
      expect(v.stubs).toEqual([{ ...answer(), failure: v.failure }]);
      expect(v.title).toContain('"refund-answer"');
      expect(v.rationale).toContain('"refund-answer"');
      expect(v.rationale.length).toBeLessThanOrEqual(400);
    }
    expect(byKind["truncated_json"]?.expected).toMatch(/errored/);
    expect(byKind["http_500"]?.expected).toMatch(/passes/);
  });

  it("proposes the timeout variant when the provider sets a timeout, and fails as many calls as it retries", () => {
    const timed = readEval(PLAN.replace("  model: example-model-1", "  model: example-model-1\n  timeout: 2000\n  max_retries: 1"), "refund-answer");
    const r = proposeVariants(timed, [answer()], ["timeout", "http_500"], PLAN);
    expect(r.accepted.map((v) => v.failure)).toEqual([{ type: "timeout", first: 1 }, { type: "http_500", first: 1 }]);
  });

  it("with retries off proposes no variant that needs a second call", () => {
    const off = readEval(PLAN.replace("  model: example-model-1", "  model: example-model-1\n  max_retries: 0"), "refund-answer");
    const r = proposeVariants(off, [answer()], FAILURE_KINDS, PLAN);
    expect(r.accepted.map((v) => v.failure.type)).toEqual(["slow_stream", "truncated_json"]);
    expect(r.rejected.filter((x) => /max_retries/.test(x.reason))).toHaveLength(3);
  });

  it("takes only the answers of this eval: a POST with its model, a 2xx response with a body, no failure", () => {
    const stubs = [
      answer({ body: "not an object" }),
      answer({ body: { model: "another-model" } }),
      answer({ response: { status: 529, json: { type: "error" } } }),
      answer({ method: "GET" }),
      answer({ failure: { type: "http_500", first: 1 } }),
      answer({ response: { status: 200 } }),
      answer({ times: "once" }),
      answer(),
    ];
    const r = proposeVariants(ev, stubs, ["reset"], PLAN);
    expect(r.accepted[0]?.stubs).toEqual([{ ...answer(), failure: { type: "reset", first: 1 } }]);
    expect(r.repeatsLeftOut).toBe(1);
  });

  it("refuses a recording with no answer for the eval, naming the model it looked for, and a plune.yaml that names no model", () => {
    expect(() => proposeVariants(ev, [answer({ body: { model: "another-model" } })], FAILURE_KINDS, PLAN)).toThrow(/no answer for eval "refund-answer".*body\.model "example-model-1"/s);
    expect(() => proposeVariants(ev, [], FAILURE_KINDS, PLAN)).toThrow(/no answer/);
    expect(() => proposeVariants({ ...ev, provider: {} }, [answer()], FAILURE_KINDS, PLAN)).toThrow(/provider\.model/);
  });

  it("does not cut a recorded stream: truncated_json is rejected for an answer that is not JSON", () => {
    const r = proposeVariants(ev, [answer({ response: { status: 200, sse: ["a", "b"] } })], ["truncated_json", "reset"], PLAN);
    expect(r.accepted.map((v) => v.failure.type)).toEqual(["reset"]);
    expect(r.rejected[0]?.reason).toMatch(/not JSON/);
  });

  it("a variant whose id plune.yaml already has is not proposed again", () => {
    const r = proposeVariants(ev, [answer()], ["reset", "http_429"], `${PLAN}  - id: refund-answer-reset\n`);
    expect(r.accepted.map((v) => v.id)).toEqual(["refund-answer-http-429"]);
    expect(r.rejected).toEqual([{ id: "refund-answer-reset", reason: "already in plune.yaml" }]);
  });

  it("the YAML is the eval as written with a new id and the stub file, and says which eval it is a variant of", () => {
    const { accepted } = proposeVariants(ev, [answer()], ["http_500"], PLAN);
    const yaml = renderProposedYaml(ev, accepted);
    expect(yaml).toContain('  # Variant of eval "refund-answer": ');
    expect(yaml).toContain('\n  - id: refund-answer-http-500\n    stubs: "stubs/refund-answer-http-500.stubs.yaml"\n    description: The refund question gets an approval.\n    prompt: "Can order {{order}} be refunded?"\n');
    expect(yaml.trimEnd().endsWith('value: "Refund approved"')).toBe(true);
    expect(yaml).not.toContain("id: other");
  });

  it("an eval that already names a stub file gets the variant's file in its place", () => {
    const stubbed = readEval(PLAN.replace("    description: The refund", "    stubs: stubs/old.stubs.yaml\n    description: The refund"), "refund-answer");
    const yaml = renderProposedYaml(stubbed, proposeVariants(stubbed, [answer()], ["reset"], PLAN).accepted);
    expect(yaml).not.toContain("old.stubs.yaml");
    expect(yaml.match(/^\s*stubs:/gm)).toHaveLength(1);
  });
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function runIt(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const work = mkdtempSync(join(tmpdir(), "cairn-failures-"));
  dirs.push(work);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text, "utf8");
  const out: string[] = [];
  const err: string[] = [];
  const o = join(work, "run");
  const r = await runProposeFailures({ eval: "refund-answer", recording: join(work, "recorded.stubs.yaml"), pluneConfig: join(work, "plune.yaml"), out: o, ...extra }, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  return { r, o, work, out: out.join(""), err: err.join("") };
}

describe("CLI · propose-failures · command", () => {
  it("writes the proposals, a stub file per variant and a review-queue report, and leaves plune.yaml and the recording as they were", async () => {
    const rec = recording([answer()]);
    const { r, o, work, out, err } = await runIt({ "plune.yaml": PLAN, "recorded.stubs.yaml": rec });
    expect(err).toBe("");
    expect(r.exitCode).toBe(0);
    const hash = (f: string): string => createHash("sha256").update(readFileSync(join(work, f))).digest("hex");
    expect(hash("plune.yaml")).toBe(createHash("sha256").update(PLAN).digest("hex"));
    expect(hash("recorded.stubs.yaml")).toBe(createHash("sha256").update(rec).digest("hex"));

    expect(readFileSync(join(o, "plune.failures.proposed.yaml"), "utf8")).toContain("- id: refund-answer-http-500");
    expect(readdirSync(join(o, "stubs")).sort()).toEqual(["refund-answer-http-429.stubs.yaml", "refund-answer-http-500.stubs.yaml", "refund-answer-reset.stubs.yaml", "refund-answer-slow-stream.stubs.yaml", "refund-answer-truncated-json.stubs.yaml"]);
    // The stub file reads back as a recording does, and holds the recorded answer with the failure.
    const stubFile = readFileSync(join(o, "stubs", "refund-answer-http-500.stubs.yaml"), "utf8");
    expect(stubFile.startsWith("# ")).toBe(true);
    expect(readRecording(stubFile)).toEqual([{ ...answer(), failure: { type: "http_500", first: 2 } }]);

    const summary = JSON.parse(readFileSync(join(o, "failure-variants.json"), "utf8"));
    expect(summary).toMatchObject({ eval: "refund-answer", accepted: 5, rejected: [{ id: "refund-answer-timeout" }], repeatsLeftOut: 0 });

    const report = JSON.parse(readFileSync(join(o, "variants", "report.json"), "utf8"));
    expect(report).toMatchObject({ schemaVersion: 1, mode: "design", cost: { totalTokens: 0 } });
    expect(report.testCases).toHaveLength(5);
    const first = report.testCases[0];
    expect(first).toMatchObject({ id: "refund-answer-http-500", type: "Negative", technique: "provider-failure", execution: "auto" });
    expect(first.title).toContain('"refund-answer"');
    expect(first.rationale).toContain('"refund-answer"');
    expect(first.stableId).toMatch(/^[0-9a-f]{12}$/);
    expect(first.steps.join(" ")).toContain("plune run --only refund-answer-http-500");
    for (const c of report.testCases) {
      // The review queue's own limits.
      expect(c.title.length).toBeLessThanOrEqual(300);
      expect(c.rationale.length).toBeLessThanOrEqual(400);
      expect(c.expected.length).toBeLessThanOrEqual(2000);
      for (const s of c.steps) expect(s.length).toBeLessThanOrEqual(400);
    }
    expect(new Set(report.testCases.map((c: { stableId: string }) => c.stableId)).size).toBe(5);
    expect(out).toMatch(/5 proposed, 1 rejected/);
    expect(out).toContain("plune ingest");
  });

  it("the same input gives the same case ids on a second run (the review queue knows a case by them)", async () => {
    const files = { "plune.yaml": PLAN, "recorded.stubs.yaml": recording([answer()]) };
    const ids = async (): Promise<string[]> => JSON.parse(readFileSync(join((await runIt(files)).o, "variants", "report.json"), "utf8")).testCases.map((c: { stableId: string }) => c.stableId);
    expect(await ids()).toEqual(await ids());
  });

  it("--failures picks the kinds; an unknown name is refused with the six", async () => {
    const files = { "plune.yaml": PLAN, "recorded.stubs.yaml": recording([answer()]) };
    const one = await runIt(files, { failures: "reset, http_429" });
    expect(readdirSync(join(one.o, "stubs")).sort()).toEqual(["refund-answer-http-429.stubs.yaml", "refund-answer-reset.stubs.yaml"]);
    const bad = await runIt(files, { failures: "http_503" });
    expect(bad.r.exitCode).toBe(1);
    expect(bad.err).toMatch(/http_503.*http_500, http_429, reset, timeout, slow_stream, truncated_json/s);
    expect(existsSync(bad.o)).toBe(false);
  });

  it("a missing recording, a recording with no answer for the eval and a missing eval each end with exit 1 and write nothing", async () => {
    const missing = await runIt({ "plune.yaml": PLAN });
    expect(missing.r.exitCode).toBe(1);
    expect(missing.err).toMatch(/recording.*not found.*plune mock --record/s);
    expect(existsSync(missing.o)).toBe(false);

    const empty = await runIt({ "plune.yaml": PLAN, "recorded.stubs.yaml": recording([]) });
    expect(empty.r.exitCode).toBe(1);
    expect(empty.err).toMatch(/no answer for eval "refund-answer"/);
    expect(existsSync(empty.o)).toBe(false);

    const noEval = await runIt({ "plune.yaml": PLAN, "recorded.stubs.yaml": recording([answer()]) }, { eval: "ghost" });
    expect(noEval.r.exitCode).toBe(1);
    expect(noEval.err).toMatch(/no eval "ghost"/);
    expect(existsSync(noEval.o)).toBe(false);

    const noPlan = await runIt({ "recorded.stubs.yaml": recording([answer()]) });
    expect(noPlan.r.exitCode).toBe(1);
    expect(noPlan.err).toMatch(/plune\.yaml.*not found/s);
    expect(existsSync(noPlan.o)).toBe(false);
  });

  it("a line break character inside a recorded text survives the stub file unchanged", async () => {
    const odd = answer({ body: { model: "example-model-1", messages: [{ role: "user", content: "a\u2028b\u0085c" }] } });
    const { o } = await runIt({ "plune.yaml": PLAN, "recorded.stubs.yaml": recording([odd]) }, { failures: "reset" });
    const text = readFileSync(join(o, "stubs", "refund-answer-reset.stubs.yaml"), "utf8");
    expect(text).not.toMatch(/[\u0085\u2028]/);
    expect(readRecording(text)[0]?.body).toEqual(odd.body);
  });
});

describe("docs · propose-failures · the guide matches the command", () => {
  const root = join(__dirname, "..", "..");
  const cli = readFileSync(join(root, "src/cli/index.ts"), "utf8");
  const block = cli.slice(cli.indexOf('.command("propose-failures")'), cli.indexOf("runProposeFailures(opts"));
  const page = readFileSync(join(root, "docs/propose-failures.md"), "utf8");

  it("every flag, failure kind and written file is named in the guide", () => {
    const flags = [...block.matchAll(/ption\("(--[a-z-]+)/g)].map((m) => m[1] as string);
    expect(flags).toHaveLength(5);
    for (const f of flags) expect(page, f).toContain(`\`${f} `);
    for (const k of FAILURE_KINDS) expect(page, k).toContain(`\`${k}\``);
    for (const f of ["plune.failures.proposed.yaml", "failure-variants.json", "variants/report.json"]) expect(page, f).toContain(f);
  });

  it("says before the first command that it tests the eval and not the product, and that the answer is a recorded one", () => {
    const first = page.indexOf("```text");
    expect(page.indexOf("does not test your product")).toBeGreaterThan(-1);
    expect(page.indexOf("does not test your product")).toBeLessThan(first);
    expect(page.indexOf("you recorded")).toBeLessThan(first);
  });
});
