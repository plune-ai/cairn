import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { dropMaskedCases, generateMcpCases, renderCasesSummary, CASES_FILE, type McpCase } from "../../src/mcp-test/cases.js";
import { runMcpTest } from "../../src/mcp-test/run.js";
import type { McpToolEntry } from "../../src/mcp-test/model.js";

/**
 * MCP-E2: cases from a tool's inputSchema. The tests check the oracle rule over ALL cases of a fixture set with a validator
 * of their own (not the one the generator uses), then each acceptance criterion on a schema made for it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-model-server.mjs");

const t = (name: string, inputSchema: Record<string, unknown>, extra: Partial<McpToolEntry> = {}): McpToolEntry => ({ name, inputSchema, ...extra });
const gen = (tools: McpToolEntry[], o: Parameters<typeof generateMcpCases>[1] = {}) => generateMcpCases(tools, { maxCasesPerTool: 200, ...o });
const of = (cases: McpCase[], tool: string, kind?: string): McpCase[] => cases.filter((c) => c.tool === tool && (kind === undefined || c.kind === kind));

const FIXTURE_SET: McpToolEntry[] = [
  t("search", {
    type: "object",
    properties: {
      q: { type: "string", minLength: 2, maxLength: 10 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      score: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      mode: { enum: ["fast", "deep"] },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      kind: { const: "doc" },
    },
    required: ["q", "kind"],
  }),
  t("choose", {
    type: "object",
    oneOf: [
      { properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      { properties: { b: { type: "integer" } }, required: ["b"], additionalProperties: false },
      { properties: { c: { type: "boolean" } }, required: ["c"], additionalProperties: false },
    ],
    properties: { a: {}, b: {}, c: {} },
  }),
  t("either", {
    type: "object",
    properties: { x: { anyOf: [{ type: "string" }, { type: "integer" }] }, y: { anyOf: [{ type: "string" }, { type: "null" }] } },
    required: ["x"],
  }),
  t("refs", {
    type: "object",
    $defs: { name: { type: "string", minLength: 3 }, pair: { type: "object", properties: { n: { $ref: "#/$defs/name" } }, required: ["n"] } },
    properties: { who: { $ref: "#/$defs/name" }, p: { $ref: "#/$defs/pair" } },
    required: ["who", "p"],
  }),
  t("plain", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
];

describe("CLI · mcp-test · cases · oracle over the whole fixture set (AC-1)", () => {
  it("every Positive passes and every Negative fails the tool's own schema, checked with a second Ajv instance built in the test (same library)", () => {
    const report = gen(FIXTURE_SET);
    expect(report.cases.length).toBeGreaterThan(25);
    for (const tool of FIXTURE_SET) {
      const ajv = new Ajv2020({ strict: false, logger: false });
      const validate = ajv.compile(tool.inputSchema);
      for (const c of of(report.cases, tool.name)) {
        expect(validate(c.args), `${c.name}: ${JSON.stringify(c.args)}`).toBe(c.type === "Positive");
      }
    }
    expect(report.errors).toEqual([]);
  });

  it("the cases are deterministic: same stableIds and names on a second run, names and ids unique", () => {
    const a = gen(FIXTURE_SET);
    const b = gen([...FIXTURE_SET].reverse());
    expect(b.cases.map((c) => [c.stableId, c.name])).toEqual(a.cases.map((c) => [c.stableId, c.name]));
    expect(new Set(a.cases.map((c) => c.name)).size).toBe(a.cases.length);
    expect(new Set(a.cases.map((c) => c.stableId)).size).toBe(a.cases.length);
    expect(JSON.stringify(a)).toBe(JSON.stringify(gen(FIXTURE_SET)));
  });

  it("the case fields: technique and type are from the closed lists, Negative expects both rejection forms", () => {
    const report = gen(FIXTURE_SET);
    for (const c of report.cases) {
      expect(["Positive", "Negative"]).toContain(c.type);
      expect(["equivalence-partitioning", "boundary-value", "error-guessing"]).toContain(c.technique);
      if (c.type === "Negative") expect(c.expect).toEqual({ outcome: "rejected", forms: [{ jsonRpcErrorCode: -32602 }, { resultIsError: true }] });
      else expect(c.expect).toMatchObject({ outcome: "success" });
    }
  });
});

describe("CLI · mcp-test · cases · branches (AC-2, AC-7)", () => {
  it("oneOf with three branches gives three branch cases, anyOf with two gives two", () => {
    const r = gen([
      FIXTURE_SET[1] as McpToolEntry,
      t("any", { type: "object", anyOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "integer" } }, required: ["b"] }], properties: { a: {}, b: {} } }),
    ]);
    expect(of(r.cases, "choose", "branch").map((c) => c.detail)).toEqual(["oneOf[0]", "oneOf[1]", "oneOf[2]"]);
    expect(of(r.cases, "any", "branch").map((c) => c.detail)).toEqual(["anyOf[0]", "anyOf[1]"]);
    expect(of(r.cases, "choose", "branch").map((c) => Object.keys(c.args))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("a nullable anyOf property still gets a wrong-type case, with a type neither branch allows", () => {
    const r = gen([FIXTURE_SET[2] as McpToolEntry]);
    const wrong = of(r.cases, "either", "wrong-type").find((c) => c.detail === "y");
    expect(wrong).toBeDefined();
    const v = (wrong as McpCase).args["y"];
    expect(typeof v === "string" || v === null).toBe(false);
  });

  it("a property whose anyOf branches are listed gets one case per branch", () => {
    const r = gen([FIXTURE_SET[2] as McpToolEntry]);
    expect(of(r.cases, "either", "branch").map((c) => c.detail)).toEqual(["x.anyOf[0]", "x.anyOf[1]", "y.anyOf[0]", "y.anyOf[1]"]);
  });
});

describe("CLI · mcp-test · cases · $ref (AC-3, AC-4, AC-5)", () => {
  it("a local $ref to $defs is followed: the valid case has a real object, not null", () => {
    const r = gen([FIXTURE_SET[3] as McpToolEntry]);
    const valid = of(r.cases, "refs", "valid")[0] as McpCase;
    expect(valid.args["who"]).toMatch(/^.{3,}$/);
    expect(valid.args["p"]).toEqual({ n: expect.stringMatching(/^.{3,}$/) });
  });

  it("a cyclic $ref ends in a skipped entry within the time limit", () => {
    const start = Date.now();
    const r = gen([t("loop", { type: "object", $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, properties: { v: { $ref: "#/$defs/a" } }, required: ["v"] })]);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(r.cases).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ tool: "loop", keyword: "$ref", reason: expect.stringContaining("cyclic") })]);
  });

  it("a recursive object schema (a tree) is skipped or bounded, never an endless build", () => {
    const r = gen([t("tree", { type: "object", properties: { next: { $ref: "#" } }, required: ["next"] })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it("an external $ref is not loaded: the tool is skipped with the keyword and no request is made", () => {
    const orig = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      throw new Error("no network");
    }) as typeof fetch;
    try {
      const r = gen([t("ext", { type: "object", properties: { v: { $ref: "https://example.com/schema.json" } }, required: ["v"] })]);
      expect(fetched).toBe(0);
      expect(r.cases).toEqual([]);
      expect(r.skipped).toEqual([expect.objectContaining({ tool: "ext", kind: "tool", keyword: "$ref" })]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("CLI · mcp-test · cases · constraints (AC-6)", () => {
  const r = gen([FIXTURE_SET[0] as McpToolEntry]);
  const by = (detail: string): McpCase => of(r.cases, "search").find((c) => c.detail === detail) as McpCase;

  it("the valid case honours const, minLength and exclusiveMinimum", () => {
    const valid = by("required");
    expect(valid.args["kind"]).toBe("doc");
    expect((valid.args["q"] as string).length).toBeGreaterThanOrEqual(2);
    const s = gen([t("ex", { type: "object", properties: { n: { type: "number", exclusiveMinimum: 5 } }, required: ["n"] })]);
    expect((of(s.cases, "ex", "valid")[0] as McpCase).args["n"]).toBeGreaterThan(5);
  });

  it("boundary cases sit on and beyond each limit", () => {
    expect(by("limit.minimum.on")).toMatchObject({ type: "Positive", args: { limit: 1 } });
    expect(by("limit.minimum.beyond")).toMatchObject({ type: "Negative", args: { limit: 0 } });
    expect(by("limit.maximum.on")).toMatchObject({ type: "Positive", args: { limit: 50 } });
    expect(by("limit.maximum.beyond")).toMatchObject({ type: "Negative", args: { limit: 51 } });
    expect((by("q.maxLength.on").args["q"] as string).length).toBe(10);
    expect((by("q.maxLength.beyond").args["q"] as string).length).toBe(11);
    expect((by("q.minLength.beyond").args["q"] as string).length).toBe(1);
    expect(by("score.exclusiveMinimum.on").type).toBe("Negative");
    expect(by("score.exclusiveMinimum.beyond").type).toBe("Positive");
    expect((by("tags.maxItems.beyond").args["tags"] as unknown[]).length).toBe(4);
    expect(by("tags.minItems.beyond")).toMatchObject({ type: "Negative", args: { tags: [] } });
  });

  it("an enum gives one case per value", () => {
    expect(of(r.cases, "search", "enum").map((c) => c.detail)).toEqual(['mode="fast"', 'mode="deep"']);
  });

  it("missing-required drops each required argument", () => {
    expect(of(r.cases, "search", "missing-required").map((c) => c.detail)).toEqual(["kind", "q"]);
  });
});

describe("CLI · mcp-test · cases · what cannot be built is skipped, with the keyword (AC-8)", () => {
  it("a schema with a draft-07 $schema is skipped with $schema, not crashed", () => {
    const r = gen([t("old", { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ tool: "old", kind: "tool", keyword: "$schema" })]);
  });

  it("a 2020-12 $schema is accepted", () => {
    const r = gen([t("new", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { a: { type: "string" } }, required: ["a"] })]);
    expect(of(r.cases, "new").length).toBeGreaterThan(0);
  });

  it("a pattern is never read: the oracle refuses the value and the case is skipped naming the keyword", () => {
    const r = gen([t("pat", { type: "object", properties: { code: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" } }, required: ["code"] })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped).toContainEqual(expect.objectContaining({ tool: "pat", kind: "valid", keyword: "pattern" }));
  });

  it("a limit the generator cannot build (a string of 1000 characters) is skipped with the keyword, and the rest is kept", () => {
    const r = gen([t("big", { type: "object", properties: { s: { type: "string", maxLength: 1000 } }, required: ["s"] })]);
    expect(r.skipped).toContainEqual(expect.objectContaining({ tool: "big", kind: "boundary", detail: "s.maxLength.on", keyword: "maxLength" }));
    expect(of(r.cases, "big", "valid")).toHaveLength(1);
  });

  it("an unsatisfiable schema (not) is skipped with its keyword", () => {
    const r = gen([t("nt", { type: "object", properties: { a: { not: {} } }, required: ["a"] })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ tool: "nt", keyword: "not" });
  });

  it("the self-check: an exclusiveMinimum schema never yields a Positive on the boundary", () => {
    const r = gen([t("ex", { type: "object", properties: { n: { type: "integer", exclusiveMinimum: 0 } }, required: ["n"] })]);
    for (const c of of(r.cases, "ex", "boundary")) {
      if (c.detail === "n.exclusiveMinimum.on") expect(c.type).toBe("Negative");
    }
    expect((of(r.cases, "ex", "valid")[0] as McpCase).args["n"]).toBe(1);
  });

  it("a schema too deep or with too many nodes is skipped as a limit, quickly", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200; i++) deep = { type: "object", properties: { n: deep }, required: ["n"] };
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`p${i}`, { type: "string" }])) };
    const start = Date.now();
    const r = gen([t("deep", deep), t("wide", wide)]);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.cases).toEqual([]);
    expect(r.skipped.map((s) => [s.tool, s.keyword])).toEqual([["deep", "limit"], ["wide", "limit"]]);
  });

  it("a tool with no properties says there are no cases, and the summary does not call it fine", () => {
    const r = gen([t("empty", { type: "object" })]);
    expect(r.noCases).toEqual(["empty"]);
    const text = renderCasesSummary(r).join("\n");
    expect(text).toMatch(/empty: no cases/);
    expect(text).not.toMatch(/all good|ok\b/i);
  });

  it("two tools with one name: the second is skipped", () => {
    const r = gen([FIXTURE_SET[4] as McpToolEntry, FIXTURE_SET[4] as McpToolEntry]);
    expect(r.skipped).toEqual([expect.objectContaining({ tool: "plain", keyword: "name" })]);
  });
});

describe("CLI · mcp-test · cases · identity and names (AC-9)", () => {
  it("names that differ only by case, and the same enum value in two properties, still get unique ids and names", () => {
    const r = gen([t("dup", { type: "object", properties: { A: { enum: ["x"] }, a: { enum: ["x"] } }, required: ["A"] })]);
    const names = r.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(r.cases.map((c) => c.stableId)).size).toBe(r.cases.length);
  });

  it("the stableId does not change with the argument values", () => {
    const a = gen([t("s", { type: "object", properties: { v: { type: "string", default: "one" } }, required: ["v"] })]);
    const b = gen([t("s", { type: "object", properties: { v: { type: "string", default: "two" } }, required: ["v"] })]);
    expect(of(a.cases, "s", "valid")[0]?.stableId).toBe(of(b.cases, "s", "valid")[0]?.stableId);
    expect(of(a.cases, "s", "valid")[0]?.args).not.toEqual(of(b.cases, "s", "valid")[0]?.args);
  });
});

describe("CLI · mcp-test · cases · the limit per tool (AC-10)", () => {
  it("cases over --max-cases-per-tool are cut, counted and listed by kind; the valid case and negatives stay first", () => {
    const r = generateMcpCases([FIXTURE_SET[0] as McpToolEntry], { maxCasesPerTool: 5 });
    expect(r.cases).toHaveLength(5);
    expect(r.cases[0]?.kind).toBe("valid");
    const total = gen([FIXTURE_SET[0] as McpToolEntry]).cases.length;
    expect(r.cut).toEqual([expect.objectContaining({ tool: "search", count: total - 5 })]);
    expect(Object.values(r.cut[0]?.kinds ?? {}).reduce((a, b) => a + b, 0)).toBe(total - 5);
    expect(renderCasesSummary(r).join("\n")).toMatch(new RegExp(`${total - 5} more cut at --max-cases-per-tool 5`));
  });

  it("the cut does not change the ids and names of the cases that stay", () => {
    const all = gen([FIXTURE_SET[0] as McpToolEntry]).cases;
    const some = generateMcpCases([FIXTURE_SET[0] as McpToolEntry], { maxCasesPerTool: 4 }).cases;
    expect(some.map((c) => c.stableId)).toEqual(all.slice(0, 4).map((c) => c.stableId));
  });
});

describe("CLI · mcp-test · cases · examples (AC-11)", () => {
  const tool = t("e", { type: "object", properties: { v: { type: "string", examples: ["from-schema"] }, w: { type: "integer", minimum: 3 } }, required: ["v", "w"] });

  it("a schema example becomes the valid value", () => {
    expect((of(gen([tool]).cases, "e", "valid")[0] as McpCase).args["v"]).toBe("from-schema");
  });

  it("a value from the examples file overrides it, and the valid case says where it came from", () => {
    const r = gen([tool], { examples: { e: { v: "mine", w: 9 } } });
    expect(of(r.cases, "e", "valid")[0]).toMatchObject({ args: { v: "mine", w: 9 }, source: "examples-file" });
    expect(of(r.cases, "e", "missing-required").length).toBe(2);
  });

  it("a file value the schema refuses is an error that names the tool, and no cases are made for it", () => {
    const r = gen([tool], { examples: { e: { v: "mine", w: 1 } } });
    expect(r.errors).toEqual([expect.objectContaining({ tool: "e", message: expect.stringContaining('"e"') })]);
    expect(r.cases).toEqual([]);
  });
});

describe("CLI · mcp-test · cases · the command (AC-12)", () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), "cairn-mcp-cases-"));
  const cleanup = (d: string): void => {
    for (const f of readdirSync(d)) unlinkSync(join(d, f));
    rmdirSync(d);
  };
  const run = async (extra: Record<string, unknown> = {}) => {
    const out = dir();
    let stdout = "";
    let stderr = "";
    const r = await runMcpTest({ command: ["node", fixture], out, ...extra }, { out: (s) => (stdout += s), err: (s) => (stderr += s) });
    return { out, r, stdout, stderr };
  };

  it("with no call flag it writes mcp-cases.json next to the model and the guard report, prints a summary, and exits 0", async () => {
    const { out, r, stdout } = await run();
    try {
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(out, CASES_FILE))).toBe(true);
      expect(existsSync(join(out, "mcp-model.json"))).toBe(true);
      expect(existsSync(join(out, "mcp-guard.json"))).toBe(true);
      const file = JSON.parse(readFileSync(join(out, CASES_FILE), "utf8")) as { cases: McpCase[]; version: number };
      expect(file.version).toBe(1);
      expect(file.cases.length).toBeGreaterThan(0);
      expect(stdout).toMatch(/Cases from inputSchema: \d+/);
      expect(stdout).toMatch(/nothing was sent/);
      // The oracle rule over every case the fixture server's own tools produce.
      const model = JSON.parse(readFileSync(join(out, "mcp-model.json"), "utf8")) as { tools: McpToolEntry[] };
      for (const tl of model.tools) {
        const validate = new Ajv2020({ strict: false, logger: false }).compile(tl.inputSchema);
        for (const c of file.cases.filter((x) => x.tool === tl.name)) expect(validate(c.args), c.name).toBe(c.type === "Positive");
      }
    } finally {
      cleanup(out);
    }
  });

  it("--max-cases-per-tool is read, and a bad value is a usage error", async () => {
    const { out, r } = await run({ maxCasesPerTool: "2" });
    try {
      const file = JSON.parse(readFileSync(join(out, CASES_FILE), "utf8")) as { cases: McpCase[]; maxCasesPerTool: number };
      expect(file.maxCasesPerTool).toBe(2);
      for (const tl of new Set(file.cases.map((c) => c.tool))) expect(file.cases.filter((c) => c.tool === tl).length).toBeLessThanOrEqual(2);
      expect(r.exitCode).toBe(0);
    } finally {
      cleanup(out);
    }
    await expect(run({ maxCasesPerTool: "0" })).rejects.toThrow(/max-cases-per-tool/);
  });

  it("--examples with an unknown tool, bad JSON, or a value the schema refuses ends in an error, not a silent fallback", async () => {
    const d = dir();
    try {
      const unknown = join(d, "unknown.json");
      writeFileSync(unknown, JSON.stringify({ no_such_tool: { a: 1 } }));
      const a = await run({ examples: unknown });
      expect(a.r.exitCode).toBe(1);
      expect(a.stderr).toMatch(/no_such_tool/);
      expect(existsSync(join(a.out, CASES_FILE))).toBe(true);
      cleanup(a.out);
      const bad = join(d, "bad.json");
      writeFileSync(bad, "{ not json");
      await expect(run({ examples: bad })).rejects.toThrow(/not valid JSON/);
      await expect(run({ examples: join(d, "missing.json") })).rejects.toThrow(/does not exist/);
    } finally {
      for (const f of readdirSync(d)) unlinkSync(join(d, f));
      rmdirSync(d);
    }
  });

  it("the schema text in the summary goes through safeText: control characters and workflow prefixes are not printed", () => {
    const evil = "::error::x\u001b[2J";
    const r = gen([t(evil, { type: "object", properties: { [`${evil}p`]: { enum: [evil] } }, required: [] })]);
    const text = renderCasesSummary(r).join("\n");
    expect(text).not.toContain("\u001b");
  });
});

describe("CLI · mcp-test · cases · after review", () => {
  // The hostile pattern needs exponential time on a string of a's with no b at the end; the length makes it hang for good.
  const HOSTILE_N = 64;
  const hostile = (name: string): McpToolEntry =>
    t(name, { type: "object", properties: { a: { type: "string", pattern: "^(a+)+b$", minLength: HOSTILE_N } }, required: ["a"] });

  it("B1 · a hostile pattern ends the tool as skipped under pattern within the test's own timeout; other tools are unaffected", () => {
    const benign = t("benign", { type: "object", properties: { w: { type: "string", pattern: "^[a-z]+$" } }, required: ["w"] });
    const start = Date.now();
    const r = gen([hostile("hostile"), benign, FIXTURE_SET[4] as McpToolEntry]);
    expect(Date.now() - start).toBeLessThan(12000);
    expect(of(r.cases, "hostile")).toEqual([]);
    expect(r.skipped.filter((s) => s.tool === "hostile")).toEqual([expect.objectContaining({ kind: "tool", keyword: "pattern", reason: expect.stringContaining("too long") })]);
    expect(of(r.cases, "benign", "valid")[0]?.args).toEqual({ w: "a" });
    const validate = new Ajv2020({ strict: false, logger: false }).compile((benign as McpToolEntry).inputSchema);
    for (const c of of(r.cases, "benign")) expect(validate(c.args), c.name).toBe(c.type === "Positive");
    expect(of(r.cases, "plain").length).toBeGreaterThan(0);
  }, 20000);

  it("B1 · a benign pattern still produces cases", () => {
    const r = gen([t("benign", { type: "object", properties: { w: { type: "string", pattern: "^[a-z]+$" } }, required: ["w"] })]);
    expect(r.cases.length).toBeGreaterThan(1);
    expect(r.skipped).toEqual([]);
  }, 20000);

  const NAMES = ["toString", "constructor", "__proto__", "hasOwnProperty"];

  it("B2 · tools named like inherited properties do not crash the run, with and without --examples", () => {
    const tools = NAMES.map((n) => t(n, { type: "object", properties: { a: { type: "string" } }, required: ["a"] }));
    const plain = gen(tools);
    for (const n of NAMES) expect(of(plain.cases, n, "valid"), n).toHaveLength(1);
    const examples = JSON.parse('{"__proto__":{"a":"mine"},"toString":{"a":"x"}}') as Record<string, Record<string, unknown>>;
    const withEx = gen(tools, { examples });
    expect(withEx.errors).toEqual([]);
    expect(of(withEx.cases, "__proto__", "valid")[0]).toMatchObject({ args: { a: "mine" }, source: "examples-file" });
    expect(of(withEx.cases, "toString", "valid")[0]).toMatchObject({ args: { a: "x" }, source: "examples-file" });
    expect(of(withEx.cases, "constructor", "valid")[0]).toMatchObject({ source: "schema" });
  });

  it("B2 · argument names like inherited properties are kept as own properties", () => {
    const props = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"string"},"toString":{"type":"string","format":"constructor"}}');
    const r = gen([t("odd", { type: "object", properties: props, required: ["__proto__", "constructor", "toString"] })]);
    const valid = of(r.cases, "odd", "valid")[0] as McpCase;
    expect(Object.keys(valid.args).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(valid.args, "__proto__")).toBe(true);
    expect(of(r.cases, "odd", "missing-required").map((c) => c.detail).sort()).toEqual(["__proto__", "constructor", "toString"]);
  });

  it("B3 · tools Foo, foo and a name with a trailing space get distinct ids, in any order", () => {
    const mk = (n: string): McpToolEntry => t(n, { type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    const tools = [mk("Foo"), mk("foo"), mk("foo ")];
    const a = gen(tools);
    expect(new Set(a.cases.map((c) => c.stableId)).size).toBe(a.cases.length);
    expect(new Set(a.cases.map((c) => c.name)).size).toBe(a.cases.length);
    const b = gen([...tools].reverse());
    const ids = (r: typeof a): string[] => r.cases.map((c) => `${c.name}=${c.stableId}`).sort();
    expect(ids(b)).toEqual(ids(a));
  });

  it("B3 · the id of an enum value does not depend on the order of the values or properties", () => {
    const e = (vals: string[]): McpToolEntry => t("e", { type: "object", properties: { v: { enum: vals } }, required: ["v"] });
    const idOf = (r: ReturnType<typeof gen>, d: string): string | undefined => r.cases.find((c) => c.detail === d)?.stableId;
    const a = gen([e(["A", "a"])]);
    const b = gen([e(["a", "A"])]);
    expect(idOf(a, 'v="A"')).toBeDefined();
    expect(idOf(a, 'v="A"')).toBe(idOf(b, 'v="A"'));
    expect(idOf(a, 'v="a"')).toBe(idOf(b, 'v="a"'));
    expect(idOf(a, 'v="A"')).not.toBe(idOf(a, 'v="a"'));
    const p = (names: string[]): McpToolEntry => t("p", { type: "object", properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])), required: names });
    const x = gen([p(["Id", "id"])]);
    const y = gen([p(["id", "Id"])]);
    const key = (r: typeof x): string[] => r.cases.map((c) => `${c.name}=${c.stableId}`).sort();
    expect(key(x)).toEqual(key(y));
    expect(new Set(x.cases.map((c) => c.stableId)).size).toBe(x.cases.length);
  });

  it("N1 · a negative must fail for the reason its kind names; integer is detected in a type list", () => {
    const r = gen([t("n", { type: "object", properties: { n: { type: ["integer", "null"], minimum: 3 }, m: { enum: ["a", "b"] } }, required: ["n"] })]);
    expect(of(r.cases, "n", "boundary").find((c) => c.detail === "n.minimum.beyond")?.args).toEqual({ n: 2 });
    expect(of(r.cases, "n", "wrong-type").map((c) => c.detail)).toEqual(["n"]);
    expect(r.skipped).toContainEqual(expect.objectContaining({ tool: "n", kind: "wrong-type", detail: "m", keyword: "type" }));
  });

  it("N3 · a huge schema under a property named default is still caught by the scan limit", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 3000; i++) deep = { type: "object", properties: { n: deep } };
    const r = gen([t("hid", { type: "object", properties: { default: deep } })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ tool: "hid", keyword: "limit" })]);
  });

  it("N3 · a oneOf of 1000 branches ends as a named skip, not a generic compile failure", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ type: "object", properties: { [`k${i}`]: { type: "string" } }, required: [`k${i}`] }));
    const r = gen([t("wide", { type: "object", oneOf: many, properties: { k0: {} } })]);
    expect(r.cases).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ tool: "wide", keyword: "oneOf", reason: expect.stringContaining("1000") })]);
  });

  it("N5 · a case whose argument holds a masked value is dropped to skipped, not written masked", () => {
    const r = gen([t("m", { type: "object", properties: { token: { type: "string", default: "hunter2-secret-value" } }, required: ["token"] })]);
    const cleaned = dropMaskedCases(r, ["hunter2-secret-value"]);
    expect(of(cleaned.cases, "m", "valid")).toEqual([]);
    expect(cleaned.skipped).toContainEqual(expect.objectContaining({ tool: "m", kind: "valid", keyword: "masked", reason: "value masked" }));
    expect(JSON.stringify(cleaned.cases)).not.toContain("hunter2-secret-value");
  });

  it("N7 · an example for a tool that gets no cases is an error naming the tool", () => {
    const r = gen([t("empty", { type: "object" })], { examples: { empty: { a: 1 } } });
    expect(r.errors).toEqual([expect.objectContaining({ tool: "empty" })]);
  });

  it("N8 · a $schema with a trailing # is accepted, as is the exact URI", () => {
    for (const s of ["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"]) {
      const r = gen([t("ok", { $schema: s, type: "object", properties: { a: { type: "string" } }, required: ["a"] })]);
      expect(of(r.cases, "ok").length, s).toBeGreaterThan(0);
    }
  });
});
