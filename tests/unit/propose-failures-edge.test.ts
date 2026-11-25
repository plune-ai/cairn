import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EVAL_ID, proposeVariants, readEval, renderProposedYaml, runProposeFailures, type RecordedStub } from "../../src/failure-variants/index.js";

/**
 * `cairn propose-failures` reads `plune.yaml` line by line. These are the shapes of a real file that reading has to get
 * right or refuse: comments, a block scalar that ends the eval, a list of providers, CRLF, a list at column 0, and the
 * limits of the review queue and of the folder it writes into.
 */
const plan = (provider: string[], evalLines: string[], after: string[] = ["judge:", "  model: x", ""]): string =>
  ["version: 1", ...provider, "evals:", "  - id: other", "    prompt: hi", "    dataset: { examples: [{ vars: {} }] }", "    assertions: []", ...evalLines, ...after].join("\n");
const PROVIDER = ["provider:", "  model: example-model-1"];
const EVAL = ["  - id: refund-answer", '    prompt: "Can order {{order}} be refunded?"', "    dataset: { examples: [{ vars: { order: 1042 } }] }", "    assertions:", "      - type: contains", '        value: "Refund approved"'];
const PLAN = plan(PROVIDER, EVAL);

const answer = (over: Record<string, unknown> = {}): RecordedStub => ({
  method: "POST",
  times: "always",
  path: "/v1/messages",
  body: { model: "example-model-1", messages: [{ role: "user", content: "Can order 1042 be refunded?" }] },
  match: "exact",
  response: { status: 200, json: { type: "message", content: [{ type: "text", text: "Refund approved for order 1042." }] } },
  ...over,
});
const recording = (stubs: unknown[]): string => `# Recorded by \`plune mock --record\`\n${JSON.stringify({ version: 1, stubs }, null, 2)}\n`;

describe("CLI · propose-failures · reading · comments in provider", () => {
  it("a commented value is not a value: the live max_retries, timeout and model are the ones read", () => {
    const text = plan(["provider:", "  # model: old-model", "  model: example-model-1", "  # timeout: 5000", "  # max_retries: 2", "  max_retries: 0"], EVAL);
    expect(readEval(text, "refund-answer").provider).toEqual({ model: "example-model-1", maxRetries: 0 });
  });

  it("with a commented max_retries above a live 0, no variant that needs a second call is proposed", () => {
    const text = plan(["provider:", "  model: example-model-1", "  # max_retries: 2", "  max_retries: 0"], EVAL);
    const r = proposeVariants(readEval(text, "refund-answer"), [answer()], ["http_500", "slow_stream"], text);
    expect(r.accepted.map((v) => v.failure.type)).toEqual(["slow_stream"]);
    expect(r.rejected[0]?.reason).toMatch(/max_retries is 0/);
  });

  it("a comment after a value ends the value; a # inside quotes does not; a quoted name keeps its space", () => {
    const read = (model: string): string | undefined => readEval(plan(["provider:", `  model: ${model}`], EVAL), "refund-answer").provider.model;
    expect(read("example-model-1 # was old-model")).toBe("example-model-1");
    expect(read('"vendor/model#beta" # note')).toBe("vendor/model#beta");
    expect(read("'my model'")).toBe("my model");
  });

  it("the eval's own provider is read without its comments too", () => {
    const own = ["    provider:", "      # model: old-model", "      timeout: 1500 # ms"];
    expect(readEval(plan(PROVIDER, [...EVAL, ...own]), "refund-answer").provider).toEqual({ model: "example-model-1", timeout: 1500 });
  });
});

describe("CLI · propose-failures · reading · the end of the eval", () => {
  it("a block scalar that ends the eval keeps a last line that starts with #", () => {
    const scalar = ["  - id: refund-answer", "    dataset: { examples: [{ vars: {} }] }", "    assertions: []", "    prompt: |", "      Answer the question.", "", "      # Rules", "", "  # the next eval", "  - id: next", "    prompt: x"];
    const e = readEval(plan(PROVIDER, scalar), "refund-answer");
    expect(e.block.slice(-3)).toEqual(["      Answer the question.", "", "      # Rules"]);
    const yaml = renderProposedYaml(e, proposeVariants(e, [answer()], ["reset"], "").accepted);
    expect(yaml).toContain("    prompt: |\n      Answer the question.\n\n      # Rules\n");
    expect(yaml).not.toContain("the next eval");
  });

  it("the last eval of the file is read to its last line, with or without a newline at the end", () => {
    for (const after of [[""], [], ["", "# the end", ""]]) {
      const e = readEval(plan(PROVIDER, EVAL, after), "refund-answer");
      expect(e.block.at(-1)).toBe('        value: "Refund approved"');
    }
  });

  it("CRLF line ends and a list at column 0 give the same eval", () => {
    const want = readEval(PLAN, "refund-answer");
    expect(readEval(PLAN.replace(/\n/g, "\r\n"), "refund-answer")).toEqual(want);
    const atZero = PLAN.split("\n").map((l) => (/^ {2}/.test(l) && !/^ {2}model:/.test(l) ? l.slice(2) : l)).join("\n");
    expect(atZero).toContain("\n- id: refund-answer\n  prompt:");
    expect(readEval(atZero, "refund-answer")).toEqual(want);
  });

  it("stubs as the first key of the item gives way to the variant's file and keeps the dash", () => {
    const first = ["  - stubs: stubs/old.stubs.yaml", "    id: refund-answer", ...EVAL.slice(1)];
    const e = readEval(plan(PROVIDER, first), "refund-answer");
    const yaml = renderProposedYaml(e, proposeVariants(e, [answer()], ["reset"], "").accepted);
    expect(yaml).toContain('\n  - stubs: "stubs/refund-answer-reset.stubs.yaml"\n    id: refund-answer-reset\n    prompt:');
    expect(yaml.match(/stubs:/g)).toHaveLength(1);
  });
});

describe("CLI · propose-failures · reading · what is refused", () => {
  it("a root provider that is a list of models is refused, however it is indented", () => {
    for (const provider of [
      ["provider:", "  - model: example-model-1", "  - model: example-model-2"],
      ["provider:", "- model: example-model-1", "- model: example-model-2"],
      ["provider:   # two models", "", "  # first", "  - model: example-model-1"],
      ["provider: [{ model: example-model-1 }, { model: example-model-2 }]"],
    ]) {
      expect(() => readEval(plan(provider, EVAL), "refund-answer"), provider.join("|")).toThrow(/provider.*list.*every model/s);
    }
  });

  it("a provider given as a YAML alias is refused, at the root and on the eval", () => {
    expect(() => readEval(plan(["provider: *fast"], EVAL), "refund-answer")).toThrow(/alias/);
    expect(() => readEval(plan(PROVIDER, [...EVAL, "    provider: *fast"]), "refund-answer")).toThrow(/alias/);
  });

  it(`an eval id of ${MAX_EVAL_ID} characters fits the review queue's limits, and a longer one is refused`, () => {
    const long = "a".repeat(MAX_EVAL_ID);
    const text = plan(["provider:", "  model: example-model-1", "  timeout: 1000"], EVAL).replace("refund-answer", long);
    const e = readEval(text, long);
    const { accepted } = proposeVariants(e, [answer()], ["http_500", "http_429", "reset", "timeout", "slow_stream", "truncated_json"], text);
    expect(accepted).toHaveLength(6);
    for (const v of accepted) {
      expect(v.title.length, v.id).toBeLessThanOrEqual(300);
      expect(v.rationale.length, v.id).toBeLessThanOrEqual(400);
      expect(v.expected.length, v.id).toBeLessThanOrEqual(2000);
      expect(v.rationale).toContain(`"${long}"`);
    }
    expect(() => readEval(text.replace(long, `${long}a`), `${long}a`)).toThrow(new RegExp(`longer than ${MAX_EVAL_ID}`));
  });

  it("the cut answer is said to fail every call, not to go untried", () => {
    const { accepted } = proposeVariants(readEval(PLAN, "refund-answer"), [answer()], ["truncated_json"], PLAN);
    expect(accepted[0]?.failure).toEqual({ type: "truncated_json" });
    expect(accepted[0]?.expected).toMatch(/every call/);
    expect(accepted[0]?.expected).not.toMatch(/tried again by/);
    const page = readFileSync(join(__dirname, "..", "..", "docs/propose-failures.md"), "utf8");
    expect(page).not.toMatch(/not tried again by/);
    expect(page).not.toMatch(/a later\s+CLI/);
    expect(page).toMatch(/every call/);
  });
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function runIt(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const work = mkdtempSync(join(tmpdir(), "cairn-failures-edge-"));
  dirs.push(work);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text, "utf8");
  const out: string[] = [];
  const err: string[] = [];
  const o = join(work, "run");
  const r = await runProposeFailures({ eval: "refund-answer", recording: join(work, "recorded.stubs.yaml"), pluneConfig: join(work, "plune.yaml"), out: o, ...extra }, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  return { r, o, work, out: out.join(""), err: err.join("") };
}
const FILES = { "plune.yaml": PLAN, "recorded.stubs.yaml": recording([answer()]) };

describe("CLI · propose-failures · command · what it does not write", () => {
  it("when every kind asked for is rejected it writes nothing, says why and exits 1", async () => {
    const { r, o, err } = await runIt(FILES, { failures: "timeout" });
    expect(r.exitCode).toBe(1);
    expect(err).toMatch(/no variant.*refund-answer-timeout: provider\.timeout is not set/s);
    expect(existsSync(o)).toBe(false);
  });

  it("an --out folder that already holds files is refused and left as it was", async () => {
    const work = mkdtempSync(join(tmpdir(), "cairn-failures-out-"));
    dirs.push(work);
    const o = join(work, "run");
    mkdirSync(join(o, "stubs"), { recursive: true });
    writeFileSync(join(o, "stubs", "old-variant.stubs.yaml"), "old", "utf8");
    const { r, err } = await runIt(FILES, { out: o });
    expect(r.exitCode).toBe(1);
    expect(err).toMatch(/--out.*not empty/s);
    expect(readdirSync(o)).toEqual(["stubs"]);
    expect(readdirSync(join(o, "stubs"))).toEqual(["old-variant.stubs.yaml"]);
  });

  it("an --out folder that exists and is empty is written into", async () => {
    const work = mkdtempSync(join(tmpdir(), "cairn-failures-out-"));
    dirs.push(work);
    const { r } = await runIt(FILES, { out: work, failures: "reset" });
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(work, "stubs"))).toEqual(["refund-answer-reset.stubs.yaml"]);
  });

  it("a recording or a plune.yaml over 1 MiB is refused and nothing is written", async () => {
    const big = `# ${"x".repeat(1024 * 1024)}\n`;
    const rec = await runIt({ ...FILES, "recorded.stubs.yaml": big + FILES["recorded.stubs.yaml"] });
    expect(rec.r.exitCode).toBe(1);
    expect(rec.err).toMatch(/recording is over 1 MiB/);
    expect(existsSync(rec.o)).toBe(false);
    const cfg = await runIt({ ...FILES, "plune.yaml": big + PLAN });
    expect(cfg.r.exitCode).toBe(1);
    expect(cfg.err).toMatch(/plune\.yaml is over 1 MiB/);
    expect(existsSync(cfg.o)).toBe(false);
  });

  it("an empty --failures is refused with the six kinds, not read as all of them", async () => {
    for (const failures of ["", " , "]) {
      const { r, o, err } = await runIt(FILES, { failures });
      expect(r.exitCode).toBe(1);
      expect(err).toMatch(/--failures.*http_500, http_429, reset, timeout, slow_stream, truncated_json/s);
      expect(existsSync(o)).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")("the stub files and the proposals are readable by their owner only, as a recording is", async () => {
    const { o } = await runIt(FILES, { failures: "reset" });
    expect(statSync(join(o, "stubs", "refund-answer-reset.stubs.yaml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(o, "plune.failures.proposed.yaml")).mode & 0o777).toBe(0o600);
  });
});
