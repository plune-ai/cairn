import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { MUTATING_STYLES } from "../../src/api/guard.js";
import { dropMaskedCases, generateMcpCases, renderCasesSummary, type McpCase } from "../../src/mcp-test/cases.js";
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_STRING_LENGTH,
  MCP_ADVERSARIAL_STYLES,
  parseAdversarialStyles,
  type AdversarialStyle,
} from "../../src/mcp-test/adversarial.js";
import { findAdvice } from "../../src/mcp-test/advice.js";
import { McpCallGuard } from "../../src/mcp-test/guard.js";
import { runMcpTest } from "../../src/mcp-test/run.js";
import type { McpToolEntry } from "../../src/mcp-test/model.js";

/**
 * MCP-E3: adversarial styles for tool arguments. Nothing here sends a call: the cases are data. The tests check that the
 * data is honest (the schema verdict of each case is what the schema says), bounded, exact, and that the call guard would
 * refuse the mutating styles.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "fixtures", "mcp-model-server.mjs");

const t = (name: string, inputSchema: Record<string, unknown>, extra: Partial<McpToolEntry> = {}): McpToolEntry => ({ name, inputSchema, ...extra });
const ALL = [...MCP_ADVERSARIAL_STYLES];
const gen = (tools: McpToolEntry[], adversarial: Record<string, unknown> = {}) =>
  generateMcpCases(tools, { maxCasesPerTool: 200, adversarial: { styles: ALL, ...adversarial } });
const adv = (r: ReturnType<typeof gen>, tool: string, kind?: string) => (r.adversarial ?? []).filter((c) => c.tool === tool && (kind === undefined || c.kind === kind));

const RICH = t("rich", {
  type: "object",
  properties: {
    q: { type: "string" },
    n: { type: "integer", minimum: 0 },
    list: { type: "array", items: { type: "string" } },
    o: { type: "object", properties: { x: { type: "string" } } },
  },
  required: ["q"],
  additionalProperties: false,
});
const NO_STRING = t("nostring", { type: "object", properties: { n: { type: "integer" } }, required: ["n"] });

describe("CLI · mcp-test · adversarial · the flag (AC-1)", () => {
  it("a bare flag is all four styles; an unknown name is reported and never widens the choice", () => {
    expect(parseAdversarialStyles(true)).toEqual({ styles: ALL, unknown: [] });
    expect(parseAdversarialStyles("psycho,typo")).toEqual({ styles: ["psycho"], unknown: ["typo"] });
    expect(parseAdversarialStyles("typo")).toEqual({ styles: [], unknown: ["typo"] });
    expect(parseAdversarialStyles(" hacker , hacker ,curious")).toEqual({ styles: ["curious", "hacker"], unknown: [] });
    expect(parseAdversarialStyles(undefined)).toEqual({ styles: [], unknown: [] });
    expect(parseAdversarialStyles(false)).toEqual({ styles: [], unknown: [] });
  });
});

describe("CLI · mcp-test · adversarial · the styles (AC-2)", () => {
  const r = gen([RICH, NO_STRING]);
  const kinds = (style: AdversarialStyle): string[] => adv(r, "rich").filter((c) => c.style === style).map((c) => c.kind);

  it("psycho: contract-breaking and extreme values, each on the parameter of its kind", () => {
    expect(kinds("psycho").sort()).toEqual(
      ["deep-array", "empty-string", "extra-property", "lone-surrogate", "long-string", "max-safe-integer", "negative-number", "null-byte", "proto-key"].sort(),
    );
    const by = (k: string) => adv(r, "rich", k)[0];
    expect(by("max-safe-integer")?.args["n"]).toBe(Number.MAX_SAFE_INTEGER);
    expect(by("negative-number")).toMatchObject({ args: { n: -1 }, schemaVerdict: "fails", type: "Negative", technique: "boundary-value" });
    expect(by("long-string")).toMatchObject({ schemaVerdict: "passes", type: "Positive" });
    expect(by("extra-property")).toMatchObject({ schemaVerdict: "fails", type: "Negative" });
    expect(by("empty-string")?.args["q"]).toBe("");
    expect(by("null-byte")?.args["q"]).toBe("a\u0000b");
    expect((by("lone-surrogate")?.args["q"] as string).charCodeAt(1)).toBe(0xd800);
    expect(Object.hasOwn(by("proto-key")?.args["o"] as object, "__proto__")).toBe(true);
  });

  it("hacker: the four injection strings go into the first string parameter, with their WSTG ids", () => {
    const h = adv(r, "rich").filter((c) => c.style === "hacker");
    expect(h.map((c) => [c.kind, c.wstgId, c.technique])).toEqual([
      ["sql-injection", "WSTG-INPV-05", "error-guessing"],
      ["script-injection", "WSTG-INPV-01", "error-guessing"],
      ["command-substitution", "WSTG-INPV-12", "error-guessing"],
      ["path-traversal", "WSTG-ATHZ-01", "error-guessing"],
    ]);
    for (const c of h) {
      expect(c.target).toBe("q");
      expect(c.humanOracle).toBe(true);
      expect(c.type).toBe("Positive"); // the schema allows any string: the expectation is about behaviour, not rejection
    }
  });

  it("a tool with no string parameter gets no injection cases", () => {
    expect(adv(r, "nostring").filter((c) => c.style === "hacker")).toEqual([]);
    expect(adv(r, "nostring", "max-safe-integer").length).toBe(1);
  });

  it("normal and curious tag the existing cases and make no new ones", () => {
    const tagged = r.cases.filter((c: McpCase) => c.adversarialStyle !== undefined);
    expect(tagged.filter((c) => c.adversarialStyle === "normal").every((c) => c.kind === "valid")).toBe(true);
    expect(tagged.filter((c) => c.adversarialStyle === "curious").every((c) => ["all-params", "enum", "branch"].includes(c.kind))).toBe(true);
    expect(tagged.length).toBeGreaterThan(0);
    const onlyPsycho = gen([RICH], { styles: ["psycho"] });
    expect(onlyPsycho.cases.some((c) => c.adversarialStyle !== undefined)).toBe(false);
    expect((onlyPsycho.adversarial ?? []).every((c) => c.style === "psycho")).toBe(true);
  });

  it("every case states its schema verdict honestly, checked by a second Ajv instance", () => {
    for (const tool of [RICH, NO_STRING]) {
      const validate = new Ajv2020({ strict: false, logger: false }).compile(tool.inputSchema);
      for (const c of adv(r, tool.name)) {
        const ok = validate(c.args);
        expect(c.schemaVerdict, c.name).toBe(ok ? "passes" : "fails");
        expect(c.type, c.name).toBe(ok ? "Positive" : "Negative");
      }
    }
  });

  it("the expectation is about robustness and never says the schema rejects", () => {
    for (const c of r.adversarial ?? []) {
      expect(c.expect).toEqual({
        outcome: "robust",
        accepts: ["json-rpc-error", "result-isError", "accepted-without-harm"],
        failedWhen: ["process-exit", "connection-closed", "timeout", "http-5xx"],
      });
    }
  });
});

describe("CLI · mcp-test · adversarial · limits (AC-9)", () => {
  it("string length and depth follow the configured limits and are recorded", () => {
    const r = gen([RICH], { maxStringLength: 50, maxDepth: 7 });
    expect((adv(r, "rich", "long-string")[0]?.args["q"] as string).length).toBe(50);
    let depth = 0;
    let v: unknown = adv(r, "rich", "deep-array")[0]?.args["list"];
    while (Array.isArray(v)) {
      depth++;
      v = v[0];
    }
    expect(depth).toBe(7);
    expect(r.adversarialLimits).toMatchObject({ maxStringLength: 50, maxDepth: 7 });
    expect(renderCasesSummary(r).join("\n")).toMatch(/string length 50, depth 7/);
  });

  it("the defaults are 100000 and 100", () => {
    expect([DEFAULT_MAX_STRING_LENGTH, DEFAULT_MAX_DEPTH]).toEqual([100000, 100]);
    const r = gen([RICH]);
    expect((adv(r, "rich", "long-string")[0]?.args["q"] as string).length).toBe(100000);
  });

  it("limits above the caps are refused", () => {
    expect(() => gen([RICH], { maxStringLength: 10_000_000 })).toThrow(/maxStringLength/);
    expect(() => gen([RICH], { maxDepth: 1000 })).toThrow(/maxDepth/);
  });

  it("a cap per tool and per run cuts the rest, and the cut is listed with its count", () => {
    const perTool = gen([RICH], { maxPerTool: 3 });
    expect(adv(perTool, "rich")).toHaveLength(3);
    expect(perTool.adversarialCut).toEqual([{ tool: "rich", count: 10, scope: "per-tool" }]);
    const perRun = gen([RICH, t("b", RICH.inputSchema)], { maxPerTool: 20, maxPerRun: 15 });
    expect((perRun.adversarial ?? []).length).toBe(15);
    expect(perRun.adversarialCut?.some((c) => c.scope === "per-run")).toBe(true);
    expect(renderCasesSummary(perTool).join("\n")).toMatch(/10 adversarial cases cut/);
  });
});

describe("CLI · mcp-test · adversarial · identity, names, payloads (AC-8)", () => {
  it("ids are exact and do not depend on the order of tools; names are unique; odd tool names do not crash", () => {
    const tools = ["Foo", "foo", "toString", "__proto__"].map((n) => t(n, RICH.inputSchema));
    const a = gen(tools);
    const b = gen([...tools].reverse());
    const key = (x: typeof a): string[] => (x.adversarial ?? []).map((c) => `${c.name}=${c.stableId}`).sort();
    expect(key(a)).toEqual(key(b));
    const all = [...a.cases.map((c) => c.stableId), ...(a.adversarial ?? []).map((c) => c.stableId)];
    expect(new Set(all).size).toBe(all.length);
    const names = (a.adversarial ?? []).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no payload points at a real system file, and the constants file holds no raw control characters", () => {
    const text = JSON.stringify(gen([RICH]).adversarial);
    for (const bad of ["/etc/passwd", "etc/shadow", "C:\\\\Windows", "system32", "..\\\\..", "../../"]) expect(text.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    expect(text).toContain("cairn-sentinel-not-a-real-file");
    const src = readFileSync(resolve(here, "..", "..", "src", "mcp-test", "payloads.ts"), "utf8");
    for (const ch of src) {
      const code = ch.codePointAt(0) as number;
      const raw = (code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t") || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfeff || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e);
      expect(raw, `U+${code.toString(16)} in payloads.ts`).toBe(false);
    }
    expect(src).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20}/);
  });

  it("a case whose arguments masking would change is dropped to skipped, not written masked", () => {
    const r = gen([t("m", { type: "object", properties: { token: { type: "string", default: "hunter2-secret-value" } }, required: ["token"] })]);
    expect((r.adversarial ?? []).length).toBeGreaterThan(0);
    const cleaned = dropMaskedCases(r, ["hunter2-secret-value"]);
    expect(JSON.stringify(cleaned.adversarial)).not.toContain("hunter2-secret-value");
    expect(cleaned.skipped.some((s) => s.kind === "adversarial" && s.keyword === "masked")).toBe(true);
  });
});

describe("CLI · mcp-test · adversarial · the call guard (AC-3)", () => {
  it("mapping: normal and curious are plain cases; psycho and hacker are mutating and refused without --allow-mutations", () => {
    const tool = t("get_item", RICH.inputSchema, { annotations: { readOnlyHint: true } });
    const table = ALL.map((style) => {
      const plain = new McpCallGuard({ tools: [tool], allowTools: ["get_item"] }).decide({ tool: "get_item", style });
      const withMut = new McpCallGuard({ tools: [tool], allowTools: ["get_item"], allowMutations: true }).decide({ tool: "get_item", style });
      return [style, MUTATING_STYLES.has(style), plain.allowed, withMut.allowed];
    });
    expect(table).toEqual([
      ["normal", false, true, true],
      ["curious", false, true, true],
      ["psycho", true, false, true],
      ["hacker", true, false, true],
    ]);
  });
});

describe("CLI · mcp-test · adversarial · no credentials call (AC-7)", () => {
  const tools = [t("a", RICH.inputSchema), t("b", RICH.inputSchema)];
  it("one record per server, for HTTP with credentials only, from the allowed list, with no header in it", () => {
    const r = gen(tools, { http: { authenticated: true }, allowTools: ["b", "a"], expectAuth: true });
    expect(r.noCredentials).toMatchObject({ tool: "b", expectAuth: true, sent: false });
    expect(JSON.stringify(r.noCredentials).toLowerCase()).not.toContain("authorization");
    expect(gen(tools, { http: { authenticated: false }, allowTools: ["a"] }).noCredentials).toBeUndefined();
    expect(gen(tools, { allowTools: ["a"] }).noCredentials).toBeUndefined();
    expect(gen(tools, { http: { authenticated: true }, allowTools: ["nope"] }).noCredentials).toBeUndefined();
    expect(gen(tools, { http: { authenticated: true } }).noCredentials).toBeUndefined();
  });
});

describe("CLI · mcp-test · adversarial · advice (AC-6, part)", () => {
  it("finds a stack, a path and SQL in an error text, and says only which kind and which line", () => {
    const f = findAdvice("Error: boom\n    at run (/srv/app/index.js:10:5)\nSELECT name FROM users WHERE id = 1\nopen C:\\data\\x.db");
    expect(f).toEqual([
      { kind: "stack", line: 2 },
      { kind: "path", line: 2 },
      { kind: "sql", line: 3 },
      { kind: "path", line: 4 },
    ]);
    expect(findAdvice("Traceback (most recent call last):")).toEqual([{ kind: "stack", line: 1 }]);
    // No text of the server is in a finding.
    for (const x of f) expect(Object.keys(x).sort()).toEqual(["kind", "line"]);
  });

  it("looks only at the first 2000 characters of a line and the first 200 lines", () => {
    const frame = "at run (/srv/a.js:1:2)";
    expect(findAdvice(`${"x".repeat(5000)} ${frame}`)).toEqual([]);
    expect(findAdvice(`${"x".repeat(1000)} ${frame}`).map((x) => x.kind)).toContain("stack");
    const lines = Array.from({ length: 10000 }, () => "ok");
    lines[300] = frame;
    expect(findAdvice(lines.join("\n"))).toEqual([]);
    lines[100] = frame;
    expect(findAdvice(lines.join("\n")).map((x) => x.line)).toContain(101);
    const start = Date.now();
    findAdvice(`${"at ".repeat(150000)}\n`.repeat(50));
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("CLI · mcp-test · adversarial · the command", () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), "cairn-mcp-adv-"));
  const cleanup = (d: string): void => {
    for (const f of readdirSync(d)) unlinkSync(join(d, f));
    rmdirSync(d);
  };
  const run = async (extra: Record<string, unknown>) => {
    const out = dir();
    let stdout = "";
    let stderr = "";
    const r = await runMcpTest({ command: ["node", fixture], out, ...extra }, { out: (s) => (stdout += s), err: (s) => (stderr += s) });
    return { out, r, stdout, stderr };
  };

  it("--adversarial writes the cases next to the others, says none was sent, and lists the guard verdict per case", async () => {
    const { out, r, stdout } = await run({ adversarial: true });
    try {
      expect(r.exitCode).toBe(0);
      const file = JSON.parse(readFileSync(join(out, "mcp-cases.json"), "utf8")) as { adversarial: Array<{ style: string; guard: { allowed: boolean; reason: string } }>; adversarialLimits: unknown };
      expect(file.adversarial.length).toBeGreaterThan(0);
      for (const c of file.adversarial) {
        expect(c.guard.allowed).toBe(false);
        expect(c.guard.reason.length).toBeGreaterThan(0);
      }
      expect(stdout).toMatch(/Adversarial cases: \d+/);
      expect(stdout).toMatch(/none was sent/);
      expect(stdout).toMatch(/not sent: mutations disabled/);
    } finally {
      cleanup(out);
    }
  });

  it("an unknown style is named on stderr and does not widen the choice; without the flag there are no adversarial cases", async () => {
    const a = await run({ adversarial: "typo" });
    try {
      expect(a.stderr).toMatch(/typo/);
      expect(a.stdout).not.toMatch(/Adversarial cases/);
      expect((JSON.parse(readFileSync(join(a.out, "mcp-cases.json"), "utf8")) as { adversarial?: unknown[] }).adversarial ?? []).toEqual([]);
    } finally {
      cleanup(a.out);
    }
    const b = await run({});
    try {
      expect(existsSync(join(b.out, "mcp-cases.json"))).toBe(true);
      expect(b.stdout).not.toMatch(/Adversarial cases/);
    } finally {
      cleanup(b.out);
    }
  });
});

describe("CLI · mcp-test · adversarial · after review", () => {
  it("1 · a timeout on an adversarial value skips only the adversarial cases; the ordinary ones stay", () => {
    const hostile = t("hostile", { type: "object", properties: { a: { type: "string", pattern: "^(a+)+[0-9]$", examples: ["aa0"] } }, required: ["a"] });
    const r = gen([hostile, RICH], { maxStringLength: 40 });
    expect(r.cases.filter((c) => c.tool === "hostile").length).toBeGreaterThan(0);
    expect(r.skipped.filter((x) => x.tool === "hostile" && x.kind === "tool")).toEqual([]);
    const adversarialSkips = r.skipped.filter((x) => x.tool === "hostile" && x.kind === "adversarial");
    expect(adversarialSkips.length).toBeGreaterThan(0);
    expect(adversarialSkips[0]?.keyword).toBe("pattern");
    expect(adv(r, "hostile")).toEqual([]);
    expect(adv(r, "rich").length).toBeGreaterThan(0);
    expect(renderCasesSummary(r).join("\n")).toMatch(/\d+ adversarial cases skipped/);
  }, 30000);

  it("2 · the call without credentials is not written when masking would change its arguments", () => {
    const tool = t("m", { type: "object", properties: { token: { type: "string", default: "hunter2-secret-value" } }, required: ["token"] });
    const r = gen([tool], { http: { authenticated: true }, allowTools: ["m"] });
    expect(r.noCredentials).toBeDefined();
    const cleaned = dropMaskedCases(r, ["hunter2-secret-value"]);
    expect(cleaned.noCredentials).toBeUndefined();
    expect(cleaned.skipped).toContainEqual(expect.objectContaining({ tool: "m", kind: "adversarial", detail: "no-credentials", keyword: "masked" }));
    expect(JSON.stringify(cleaned)).not.toContain("hunter2-secret-value");
  });

  it("5 · an empty style list is reported, never widened; names are lower-case only", () => {
    for (const flag of ["", ",", "  ", " , "]) expect(parseAdversarialStyles(flag), JSON.stringify(flag)).toEqual({ styles: [], unknown: [], empty: true });
    expect(parseAdversarialStyles(true).empty).toBeUndefined();
    expect(parseAdversarialStyles("PSYCHO")).toEqual({ styles: [], unknown: ["PSYCHO"] });
  });

  const dir = (): string => mkdtempSync(join(tmpdir(), "cairn-mcp-adv2-"));
  const cleanup = (d: string): void => {
    for (const f of readdirSync(d)) unlinkSync(join(d, f));
    rmdirSync(d);
  };
  const run = async (extra: Record<string, unknown>) => {
    const out = dir();
    let stdout = "";
    let stderr = "";
    const r = await runMcpTest({ command: ["node", fixture], out, ...extra }, { out: (s) => (stdout += s), err: (s) => (stderr += s) });
    return { out, r, stdout, stderr };
  };

  it("5 · --adversarial with no style in it warns on stderr and makes no adversarial cases", async () => {
    const a = await run({ adversarial: "," });
    try {
      expect(a.stderr).toMatch(/no style/);
      expect(a.stdout).not.toMatch(/Adversarial cases/);
    } finally {
      cleanup(a.out);
    }
  });

  it("6 · the limits take plain decimal integers only", async () => {
    await expect(run({ adversarial: true, adversarialMaxString: "0x10" })).rejects.toThrow(/decimal/);
    await expect(run({ adversarial: true, adversarialMaxDepth: "1e3" })).rejects.toThrow(/decimal/);
    const ok = await run({ adversarial: true, adversarialMaxString: "50", adversarialMaxDepth: "5" });
    try {
      expect(ok.r.exitCode).toBe(0);
    } finally {
      cleanup(ok.out);
    }
  });

  it("4 · one honest line says nothing was sent, with and without --allow-mutations", async () => {
    for (const extra of [{}, { allowMutations: true, allowTools: "ping" }]) {
      const x = await run({ adversarial: true, ...extra });
      try {
        expect(x.stdout, JSON.stringify(extra)).toMatch(/Adversarial: none was sent/);
      } finally {
        cleanup(x.out);
      }
    }
  });
});

describe("CLI · mcp-test · adversarial · docs say what the code does", () => {
  it("3, 9 · noCredentials is written whenever hacker is on over HTTP with headers; the SQL payload is explained", () => {
    const text = readFileSync(resolve(here, "..", "..", "docs", "mcp.md"), "utf8");
    expect(text).not.toMatch(/with `--expect-auth`, an HTTP run/);
    expect(text).toMatch(/always true/);
    expect(text).toMatch(/test account/);
  });
});
