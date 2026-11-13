/**
 * MCP-E2 — test cases for MCP tools, built from each tool's `inputSchema`. No model, no network, nothing is called.
 *
 * Every case is checked against the tool's own schema before it is kept (the "oracle", see schema.ts): a Positive case must
 * pass the schema, a Negative case must fail it. A case that does not behave so is never emitted; it is listed as skipped
 * with the keyword that explains it. Nothing here sends a call.
 */
import type { ApiCaseTechnique, ApiCaseType } from "../api/cases.js";
import { stableCaseId } from "../artifacts/contract.js";
import { safeText, type McpToolEntry } from "./model.js";
import { maskSecrets } from "./secrets.js";
import {
  ROBUST_EXPECTATION,
  buildCandidates,
  resolveLimits,
  type AdversarialLimits,
  type AdversarialOptions,
  type AdversarialStyle,
  type Targets,
} from "./adversarial.js";
import {
  CannotBuild,
  MAX_ARRAY_ITEMS,
  ORACLE_TIME_LIMIT_MS,
  OracleTimeout,
  MAX_STRING_LENGTH,
  SchemaBuilder,
  OracleHost,
  has,
  isIntegerType,
  put,
  scanSchema,
  type Oracle,
  type OracleError,
} from "./schema.js";

export const MCP_CASES_VERSION = 1;
export const DEFAULT_MAX_CASES_PER_TOOL = 12;
export const CASES_FILE = "mcp-cases.json";

/** Kinds in the order they are kept when a tool has more cases than the limit allows. */
export const CASE_KIND_PRIORITY = ["valid", "missing-required", "wrong-type", "boundary", "branch", "enum", "all-params"] as const;
export type McpCaseKind = (typeof CASE_KIND_PRIORITY)[number];

/** What a runner should accept as the server's answer to a case (nothing here executes it). */
export type McpCaseExpect =
  | { outcome: "success"; outputSchema: boolean }
  | { outcome: "rejected"; forms: Array<{ jsonRpcErrorCode: number } | { resultIsError: true }> };

export interface McpCase {
  name: string;
  stableId: string;
  tool: string;
  kind: McpCaseKind;
  detail: string;
  type: ApiCaseType;
  technique: ApiCaseTechnique;
  rationale: string;
  args: Record<string, unknown>;
  expect: McpCaseExpect;
  /** Where the `valid` arguments came from. */
  source: "schema" | "examples-file";
  /** What this case exercises beyond the arguments it sends (enum value, branch). */
  covers?: Covers;
  /** Set when `--adversarial` asked for `normal` (the valid case) or `curious` (all-params, enum, branch). */
  adversarialStyle?: AdversarialStyle;
}

/** A case from the `psycho` or `hacker` style. Nothing here sends it; the call guard decides later. */
export interface McpAdversarialCase {
  name: string;
  stableId: string;
  tool: string;
  kind: string;
  style: "psycho" | "hacker";
  /** The parameter that was changed, or "(root)". */
  target: string;
  /** What the schema says about the arguments: it is not a claim about the server. */
  schemaVerdict: "passes" | "fails";
  type: ApiCaseType;
  technique: ApiCaseTechnique;
  wstgId?: string;
  rationale: string;
  args: Record<string, unknown>;
  expect: typeof ROBUST_EXPECTATION;
  /** Whether the payload was handled safely cannot be read from an answer by a rule written here. */
  humanOracle: boolean;
  /** What the call guard would say now (set by the command). */
  guard?: { allowed: boolean; reason: string };
}

/** One call without credentials, described once per server; not sent. */
export interface McpNoCredentialsCase {
  tool: string;
  args: Record<string, unknown>;
  /** With --expect-auth a call that goes through is a failure; without it, a finding. */
  expectAuth: boolean;
  sent: false;
}

export interface McpCaseSkipped {
  tool: string;
  kind: McpCaseKind | "tool" | "adversarial";
  detail: string;
  /** The schema keyword that explains it. */
  keyword: string;
  reason: string;
  /** How many cases this record stands for (absent: one). */
  count?: number;
}

export interface McpCasesReport {
  version: number;
  maxCasesPerTool: number;
  cases: McpCase[];
  skipped: McpCaseSkipped[];
  /** Cases left out because a tool had more than the limit. */
  cut: Array<{ tool: string; count: number; kinds: Record<string, number> }>;
  /** Tools with no properties: nothing to build cases from. */
  noCases: string[];
  /** Present when `--adversarial` named a style. */
  adversarial?: McpAdversarialCase[];
  adversarialLimits?: AdversarialLimits & { styles: AdversarialStyle[] };
  adversarialCut?: Array<{ tool: string; count: number; scope: "per-tool" | "per-run" }>;
  noCredentials?: McpNoCredentialsCase;
  /** Problems the caller must treat as failures (an `--examples` value the schema refuses). */
  errors: Array<{ tool: string; message: string }>;
}

/** The time all schema checks of one run may take together; tools after that are skipped by name. */
export const TOTAL_TIME_BUDGET_MS = 15000;
export const BUDGET_SPENT_REASON = "time budget for checking schemas was spent";

export interface GenerateOptions {
  /** Milliseconds for all schema checks together (default {@link TOTAL_TIME_BUDGET_MS}). */
  timeBudgetMs?: number;
  /** MCP-E3: adversarial styles (data only: nothing is sent). */
  adversarial?: AdversarialOptions;
  maxCasesPerTool?: number;
  /** Tool name → arguments to use for the `valid` case. */
  examples?: Record<string, Record<string, unknown>>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Why a Negative case must fail: an error with this keyword at this place (and, for `required`, naming this property). */
interface Reason {
  keyword: string;
  path: string;
  missing?: string;
}

interface Candidate {
  kind: McpCaseKind;
  detail: string;
  type: ApiCaseType;
  make: () => Obj;
  reason?: Reason;
  /** What a coverage count takes this case to exercise. */
  covers?: Covers;
}

/** An enum value (as JSON) or a oneOf/anyOf branch (its detail) that a case exercises. */
export interface Covers {
  param?: string;
  enumValue?: string;
  branch?: string;
}

/** A JSON pointer to a top-level property. */
const pointerTo = (k: string): string => `/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
const failsFor = (errors: OracleError[], r: Reason): boolean =>
  errors.some((e) => e.keyword === r.keyword && e.path === r.path && (r.missing === undefined || e.missing === r.missing));
/** Every part of an id keeps case and spaces: stableCaseId folds them, the code points do not fold. */
const exact = (text: string): string => Array.from(text, (c) => (c.codePointAt(0) as number).toString(16)).join(".");

const TECHNIQUE: Record<McpCaseKind, ApiCaseTechnique> = {
  valid: "equivalence-partitioning",
  "all-params": "equivalence-partitioning",
  enum: "equivalence-partitioning",
  branch: "equivalence-partitioning",
  "missing-required": "error-guessing",
  "wrong-type": "error-guessing",
  boundary: "boundary-value",
};

const RATIONALE: Record<McpCaseKind, string> = {
  valid: "Only the required arguments, with the simplest values the schema allows.",
  "all-params": "Every declared argument at once.",
  enum: "One of the values the schema lists for this argument.",
  branch: "One branch of the schema's oneOf/anyOf.",
  "missing-required": "A required argument is left out; the schema forbids it.",
  "wrong-type": "An argument has a value of a type the schema does not allow.",
  boundary: "A value on or just beyond a limit the schema sets.",
};

/** Values of other JSON types to try, in this order, when a wrong type is needed. */
const WRONG_TYPE_CANDIDATES: unknown[] = [12345, "text", true, null, [], {}];

function expectFor(type: ApiCaseType, tool: McpToolEntry): McpCaseExpect {
  return type === "Positive"
    ? { outcome: "success", outputSchema: tool.outputSchema !== undefined }
    : { outcome: "rejected", forms: [{ jsonRpcErrorCode: -32602 }, { resultIsError: true }] };
}

function why(e: unknown): { keyword: string; reason: string } {
  if (e instanceof CannotBuild) return { keyword: e.keyword, reason: safeText(e.message, 200) };
  throw e;
}

function boundaryCandidates(prop: string, schema: Obj, builder: SchemaBuilder, base: () => Obj): Candidate[] {
  const out: Candidate[] = [];
  const num = (k: string): number | undefined => (typeof schema[k] === "number" ? (schema[k] as number) : undefined);
  const integer = isIntegerType(schema);
  const step = integer ? 1 : 0.5;
  const withValue = (v: unknown): Obj => ({ ...base(), [prop]: v });
  const add = (keyword: string, side: "on" | "beyond", type: ApiCaseType, v: () => unknown): void => {
    out.push({
      kind: "boundary",
      detail: `${prop}.${keyword}.${side}`,
      type,
      make: () => withValue(v()),
      ...(type === "Negative" ? { reason: { keyword, path: pointerTo(prop) } } : {}),
    });
  };
  const min = num("minimum");
  const max = num("maximum");
  const exMin = num("exclusiveMinimum");
  const exMax = num("exclusiveMaximum");
  if (min !== undefined) {
    add("minimum", "on", "Positive", () => min);
    add("minimum", "beyond", "Negative", () => min - step);
  }
  if (max !== undefined) {
    add("maximum", "on", "Positive", () => max);
    add("maximum", "beyond", "Negative", () => max + step);
  }
  if (exMin !== undefined) {
    add("exclusiveMinimum", "on", "Negative", () => exMin);
    add("exclusiveMinimum", "beyond", "Positive", () => exMin + step);
  }
  if (exMax !== undefined) {
    add("exclusiveMaximum", "on", "Negative", () => exMax);
    add("exclusiveMaximum", "beyond", "Positive", () => exMax - step);
  }
  const minLength = num("minLength");
  const maxLength = num("maxLength");
  const text = (n: number): string => {
    if (n > MAX_STRING_LENGTH) throw new CannotBuild("maxLength", `the string needs ${n} characters; the limit is ${MAX_STRING_LENGTH}`);
    return "a".repeat(Math.max(0, n));
  };
  if (minLength !== undefined) {
    add("minLength", "on", "Positive", () => text(minLength));
    if (minLength > 0) add("minLength", "beyond", "Negative", () => text(minLength - 1));
  }
  if (maxLength !== undefined) {
    add("maxLength", "on", "Positive", () => text(maxLength));
    add("maxLength", "beyond", "Negative", () => text(maxLength + 1));
  }
  const minItems = num("minItems");
  const maxItems = num("maxItems");
  const items = (n: number): unknown[] => {
    if (n > MAX_ARRAY_ITEMS) throw new CannotBuild("maxItems", `the array needs ${n} items; the limit is ${MAX_ARRAY_ITEMS}`);
    const one = schema["items"] === undefined ? "value" : builder.value(schema["items"], 1);
    return Array.from({ length: Math.max(0, n) }, () => clone(one));
  };
  if (minItems !== undefined) {
    add("minItems", "on", "Positive", () => items(minItems));
    if (minItems > 0) add("minItems", "beyond", "Negative", () => items(minItems - 1));
  }
  if (maxItems !== undefined) {
    add("maxItems", "on", "Positive", () => items(maxItems));
    add("maxItems", "beyond", "Negative", () => items(maxItems + 1));
  }
  return out;
}

interface ToolOutcome {
  cases: McpCase[];
  skipped: McpCaseSkipped[];
  cut?: { tool: string; count: number; kinds: Record<string, number> };
  adversarial?: McpAdversarialCase[];
  adversarialCut?: number;
  noCases?: boolean;
  errors: Array<{ tool: string; message: string }>;
}

interface ToolOptions {
  maxCasesPerTool: number;
  /** Own entries only: a tool called `toString` or `__proto__` must not find anything inherited. */
  examples: ReadonlyMap<string, Obj>;
  adversarial?: { styles: readonly AdversarialStyle[]; limits: AdversarialLimits };
}

function casesForTool(tool: McpToolEntry, opts: ToolOptions, host: OracleHost): ToolOutcome {
  const skipped: McpCaseSkipped[] = [];
  const errors: Array<{ tool: string; message: string }> = [];
  const skipTool = (e: unknown): ToolOutcome => {
    const w = why(e);
    skipped.push({ tool: tool.name, kind: "tool", detail: "", ...w });
    return { cases: [], skipped, errors };
  };
  const problem = scanSchema(tool.inputSchema);
  if (problem) return skipTool(problem);
  let oracle: Oracle;
  let builder: SchemaBuilder;
  let rootView: Obj;
  try {
    oracle = host.oracle(tool.inputSchema);
    builder = new SchemaBuilder(tool.inputSchema);
    rootView = builder.view(tool.inputSchema);
  } catch (e) {
    return skipTool(e);
  }
  try {
    return buildCases(tool, opts, oracle, builder, rootView);
  } catch (e) {
    // The schema check ran out of time or could not run: the tool gives no cases, only this entry.
    if (e instanceof CannotBuild) return skipTool(e);
    throw e;
  }
}

function buildCases(tool: McpToolEntry, opts: ToolOptions, oracle: Oracle, builder: SchemaBuilder, rootView: Obj): ToolOutcome {
  const skipped: McpCaseSkipped[] = [];
  const errors: Array<{ tool: string; message: string }> = [];
  const props = isObj(rootView["properties"]) ? rootView["properties"] : {};
  const propNames = Object.keys(props).sort();
  if (propNames.length === 0) return { cases: [], skipped, noCases: true, errors };
  const required = [...new Set((Array.isArray(rootView["required"]) ? rootView["required"] : []).filter((r): r is string => typeof r === "string"))].sort();

  // The arguments of the `valid` case: the file's, or built from the schema.
  let source: McpCase["source"] = "schema";
  let baseArgs: Obj | undefined;
  const fromFile = opts.examples.get(tool.name);
  if (fromFile !== undefined) {
    source = "examples-file";
    baseArgs = clone(fromFile);
    const r = oracle.check(baseArgs);
    if (!r.valid) {
      errors.push({
        tool: tool.name,
        message: `the value given in --examples for "${safeText(tool.name, 60)}" does not pass the tool's inputSchema (${r.keyword ?? "unknown keyword"}${r.path ? ` at ${safeText(r.path, 60)}` : ""})`,
      });
      return { cases: [], skipped, errors };
    }
  } else {
    try {
      const built = builder.value(tool.inputSchema);
      baseArgs = isObj(built) ? built : undefined;
      if (!baseArgs) throw new CannotBuild("type", "the input schema does not describe an object");
    } catch (e) {
      const w = why(e);
      skipped.push({ tool: tool.name, kind: "valid", detail: "", ...w });
      return { cases: [], skipped, errors };
    }
  }
  const base = (): Obj => clone(baseArgs as Obj);

  const cands: Candidate[] = [{ kind: "valid", detail: "required", type: "Positive", make: base }];
  for (const k of required) {
    if (has(baseArgs as Obj, k)) {
      cands.push({
        kind: "missing-required",
        detail: k,
        type: "Negative",
        make: () => {
          const a = base();
          delete a[k];
          return a;
        },
        reason: { keyword: "required", path: "", missing: k },
      });
    }
  }
  for (const k of propNames) {
    cands.push({
      kind: "wrong-type",
      detail: k,
      type: "Negative",
      reason: { keyword: "type", path: pointerTo(k) },
      make: () => {
        for (const w of WRONG_TYPE_CANDIDATES) {
          const a = { ...base(), [k]: clone(w) };
          const r = oracle.check(a);
          if (!r.valid && failsFor(r.errors, { keyword: "type", path: pointerTo(k) })) return a;
        }
        throw new CannotBuild("type", `no value of another JSON type is refused by a type check for "${safeText(k, 60)}"`);
      },
    });
  }
  for (const k of propNames) {
    try {
      cands.push(...boundaryCandidates(k, builder.view(props[k]), builder, base));
    } catch (e) {
      skipped.push({ tool: tool.name, kind: "boundary", detail: k, ...why(e) });
    }
  }
  const addBranches = (detailPrefix: string, owner: unknown, place: (v: unknown) => Obj): void => {
    let list;
    try {
      list = builder.branches(owner);
    } catch (e) {
      skipped.push({ tool: tool.name, kind: "branch", detail: detailPrefix || "root", ...why(e) });
      return;
    }
    for (const b of list) {
      const detail = `${detailPrefix}${b.keyword}[${b.index}]`;
      cands.push({ kind: "branch", detail, type: "Positive", make: () => place(builder.value(b.schema, 1)), covers: { branch: detail } });
    }
  };
  addBranches("", tool.inputSchema, (v) => {
    if (!isObj(v)) throw new CannotBuild("type", "the branch does not describe an object");
    return v;
  });
  for (const k of propNames) addBranches(`${k}.`, props[k], (v) => ({ ...base(), [k]: v }));
  for (const k of propNames) {
    let view: Obj;
    try {
      view = builder.view(props[k]);
    } catch {
      continue;
    }
    if (!Array.isArray(view["enum"])) continue;
    const seenValues = new Set<string>();
    for (const v of view["enum"].slice(0, 32)) {
      if (seenValues.has(JSON.stringify(v))) continue;
      seenValues.add(JSON.stringify(v));
      cands.push({ kind: "enum", detail: `${k}=${JSON.stringify(v)}`, type: "Positive", make: () => ({ ...base(), [k]: clone(v) }), covers: { param: k, enumValue: JSON.stringify(v) } });
    }
  }
  cands.push({
    kind: "all-params",
    detail: "all",
    type: "Positive",
    make: () => {
      const a = base();
      for (const k of propNames) if (!has(a, k)) put(a, k, builder.value(props[k], 1));
      return a;
    },
  });

  // The oracle decides. Order by kind priority first (stable inside a kind), so the cut keeps the most useful ones.
  const kept: Array<{ cand: Candidate; args: Obj }> = [];
  const seenArgs = new Set<string>();
  for (const kind of CASE_KIND_PRIORITY) {
    for (const cand of cands.filter((c) => c.kind === kind)) {
      let args: Obj;
      try {
        args = cand.make();
      } catch (e) {
        skipped.push({ tool: tool.name, kind: cand.kind, detail: cand.detail, ...why(e) });
        continue;
      }
      const r = oracle.check(args);
      if (cand.type === "Negative" && !r.valid && cand.reason && !failsFor(r.errors, cand.reason)) {
        skipped.push({
          tool: tool.name,
          kind: cand.kind,
          detail: cand.detail,
          keyword: cand.reason.keyword,
          reason: `the schema refuses it, but not for the reason of its kind (no ${cand.reason.keyword} error${cand.reason.path ? ` at ${safeText(cand.reason.path, 60)}` : ""}; first error: ${r.keyword ?? "unknown"})`,
        });
        continue;
      }
      if ((cand.type === "Positive") !== r.valid) {
        skipped.push({
          tool: tool.name,
          kind: cand.kind,
          detail: cand.detail,
          keyword: r.keyword ?? "schema",
          reason: cand.type === "Positive" ? `the schema refuses it (${r.keyword ?? "unknown keyword"})` : "the schema accepts it, so it cannot be a negative case",
        });
        continue;
      }
      const key = `${cand.type}:${JSON.stringify(args)}`;
      // Every-argument-at-once adds nothing when it equals the valid case. Other kinds are kept even when their arguments
      // match another case: which of two equal cases survives must not depend on the order of the schema's lists.
      if (cand.kind === "all-params" && seenArgs.has(key)) continue;
      seenArgs.add(key);
      kept.push({ cand, args });
    }
    if (kind === "valid" && kept.length === 0) {
      // Every other case is the valid one with one change; without a valid base none of them proves what it claims.
      const first = skipped.find((x) => x.tool === tool.name && x.kind === "valid");
      skipped.push({
        tool: tool.name,
        kind: "tool",
        detail: "derived cases",
        keyword: first?.keyword ?? "schema",
        reason: "there is no valid case to start from, so no case was made for this tool",
      });
      return { cases: [], skipped, errors };
    }
  }

  // An id is a function of the exact tool name, kind and detail alone: not of the order, the limit or the values.
  const cases: McpCase[] = kept.map(({ cand, args }) => {
    return {
      name: `${tool.name} · ${cand.kind} · ${cand.detail}`,
      stableId: stableCaseId(["mcp", exact(tool.name), exact(cand.kind), exact(cand.detail)]),
      tool: tool.name,
      kind: cand.kind,
      detail: cand.detail,
      type: cand.type,
      technique: TECHNIQUE[cand.kind],
      rationale: RATIONALE[cand.kind],
      args,
      expect: expectFor(cand.type, tool),
      source: cand.kind === "valid" ? source : "schema",
      ...(cand.covers ? { covers: cand.covers } : {}),
      ...styleTag(cand.kind, opts),
    };
  });
  const adversarialOut = opts.adversarial ? adversarialFor(tool, opts.adversarial, oracle, builder, rootView, props, propNames, baseArgs as Obj, skipped) : undefined;
  const advPart = adversarialOut ? { adversarial: adversarialOut.cases, adversarialCut: adversarialOut.cut } : {};
  if (cases.length <= opts.maxCasesPerTool) return { cases, skipped, errors, ...advPart };
  const left = cases.slice(opts.maxCasesPerTool);
  const kinds: Record<string, number> = {};
  for (const c of left) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  return { cases: cases.slice(0, opts.maxCasesPerTool), skipped, cut: { tool: tool.name, count: left.length, kinds }, errors, ...advPart };
}

function styleTag(kind: McpCaseKind, opts: ToolOptions): { adversarialStyle?: AdversarialStyle } {
  const styles = opts.adversarial?.styles ?? [];
  if (kind === "valid" && styles.includes("normal")) return { adversarialStyle: "normal" };
  if ((kind === "all-params" || kind === "enum" || kind === "branch") && styles.includes("curious")) return { adversarialStyle: "curious" };
  return {};
}

/** The type of a parameter as its schema says it (first non-null type; for a oneOf/anyOf, that of the first branch). */
function paramType(builder: SchemaBuilder, raw: unknown): string | undefined {
  const typeOf = (v: Obj): string | undefined => {
    const t = v["type"];
    if (typeof t === "string") return t;
    return Array.isArray(t) ? t.find((x): x is string => typeof x === "string" && x !== "null") : undefined;
  };
  try {
    const own = typeOf(builder.view(raw));
    if (own) return own;
    const first = builder.branches(raw)[0];
    return first ? typeOf(first.schema) : undefined;
  } catch {
    return undefined;
  }
}

export function adversarialFor(
  tool: McpToolEntry,
  adv: { styles: readonly AdversarialStyle[]; limits: AdversarialLimits },
  oracle: Oracle,
  builder: SchemaBuilder,
  rootView: Obj,
  props: Obj,
  propNames: string[],
  base: Obj,
  skipped: McpCaseSkipped[],
): { cases: McpAdversarialCase[]; cut: number } {
  const targets: Targets = {};
  for (const k of propNames) {
    const t = paramType(builder, props[k]);
    if ((t === "integer" || t === "number") && targets.number === undefined) targets.number = k;
    else if (t === "string" && targets.string === undefined) targets.string = k;
    else if (t === "array" && targets.array === undefined) targets.array = k;
    else if (t === "object" && targets.object === undefined) targets.object = k;
  }
  const baseText = JSON.stringify(base);
  const out: McpAdversarialCase[] = [];
  // After the first schema check that fails (it ran out of time, say) the rest are not tried one by one against it.
  let broken: { keyword: string; reason: string } | undefined;
  let notChecked = 0;
  for (const c of buildCandidates(base, targets, rootView["additionalProperties"] === false, adv.styles, adv.limits)) {
    if (JSON.stringify(c.args) === baseText) continue;
    if (broken) {
      notChecked += 1;
      continue;
    }
    let passes: boolean;
    try {
      passes = oracle.check(c.args).valid;
    } catch (e) {
      if (!(e instanceof CannotBuild)) throw e;
      const detail = `${c.style} · ${c.kind}`;
      if (e instanceof OracleTimeout) {
        // The time of this tool's schema check is spent: the rest are not tried against it one by one.
        broken = { keyword: e.keyword, reason: `the schema check of this tool took too long (more than ${ORACLE_TIME_LIMIT_MS} ms; a pattern may backtrack badly), so its adversarial cases were skipped` };
        skipped.push({ tool: tool.name, kind: "adversarial", detail, ...broken });
      } else {
        // This one candidate cannot be checked; the next may be.
        skipped.push({ tool: tool.name, kind: "adversarial", detail, keyword: e.keyword, reason: safeText(e.message, 200) });
      }
      continue;
    }
    out.push({
      name: `${tool.name} · ${c.style} · ${c.kind} · ${c.target}`,
      stableId: stableCaseId(["mcp-adv", exact(tool.name), exact(c.style), exact(c.kind), exact(c.target)]),
      tool: tool.name,
      kind: c.kind,
      style: c.style,
      target: c.target,
      schemaVerdict: passes ? "passes" : "fails",
      type: passes ? "Positive" : "Negative",
      technique: c.technique,
      ...(c.wstgId ? { wstgId: c.wstgId } : {}),
      rationale: c.rationale,
      args: c.args,
      expect: ROBUST_EXPECTATION,
      humanOracle: c.humanOracle,
    });
  }
  if (broken && notChecked) {
    skipped.push({
      tool: tool.name,
      kind: "adversarial",
      detail: "the rest",
      keyword: broken.keyword,
      reason: `${notChecked} more adversarial cases were not checked, because the check of this tool's schema failed first`,
      count: notChecked,
    });
  }
  const kept = out.slice(0, adv.limits.maxPerTool);
  return { cases: kept, cut: out.length - kept.length };
}

/** Test cases for every tool, in the order of the tools' names. */
export function generateMcpCases(tools: McpToolEntry[], options: GenerateOptions = {}): McpCasesReport {
  const maxCasesPerTool = options.maxCasesPerTool ?? DEFAULT_MAX_CASES_PER_TOOL;
  const report: McpCasesReport = { version: MCP_CASES_VERSION, maxCasesPerTool, cases: [], skipped: [], cut: [], noCases: [], errors: [] };
  const examples = new Map<string, Obj>(Object.entries(options.examples ?? {}));
  const advLimits = options.adversarial ? resolveLimits(options.adversarial) : undefined;
  const advStyles = options.adversarial?.styles ?? [];
  const adversarial = options.adversarial && advLimits && advStyles.length ? { styles: advStyles, limits: advLimits } : undefined;
  if (adversarial) {
    report.adversarial = [];
    report.adversarialLimits = { ...adversarial.limits, styles: [...adversarial.styles] };
    report.adversarialCut = [];
  }
  // Two tools with one exact name: neither is trusted, so the result does not depend on the order the server sent them.
  const copies = new Map<string, number>();
  for (const tool of tools) copies.set(tool.name, (copies.get(tool.name) ?? 0) + 1);
  const budgetEnd = Date.now() + (options.timeBudgetMs ?? TOTAL_TIME_BUDGET_MS);
  const host = new OracleHost();
  try {
    runTools(tools, copies, examples, maxCasesPerTool, budgetEnd, host, report, adversarial);
  } finally {
    host.close();
  }
  return finish(report, options);
}

function runTools(
  tools: McpToolEntry[],
  copies: ReadonlyMap<string, number>,
  examples: ReadonlyMap<string, Obj>,
  maxCasesPerTool: number,
  budgetEnd: number,
  host: OracleHost,
  report: McpCasesReport,
  adversarial: ToolOptions["adversarial"],
): void {
  const reported = new Set<string>();
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const n = copies.get(tool.name) ?? 1;
    if (n > 1) {
      if (!reported.has(tool.name)) {
        reported.add(tool.name);
        report.skipped.push({ tool: tool.name, kind: "tool", detail: "", keyword: "name", reason: `${n} tools have this exact name; none of them is used` });
      }
      continue;
    }
    if (Date.now() >= budgetEnd) {
      report.skipped.push({ tool: tool.name, kind: "tool", detail: "", keyword: "budget", reason: BUDGET_SPENT_REASON });
      continue;
    }
    const r = casesForTool(tool, { maxCasesPerTool, examples, ...(adversarial ? { adversarial } : {}) }, host);
    if (r.adversarial && report.adversarial) {
      report.adversarial.push(...r.adversarial);
      if (r.adversarialCut) report.adversarialCut?.push({ tool: tool.name, count: r.adversarialCut, scope: "per-tool" });
    }
    report.cases.push(...r.cases);
    report.skipped.push(...r.skipped);
    report.errors.push(...r.errors);
    if (examples.has(tool.name) && r.cases.length === 0 && r.errors.length === 0) {
      report.errors.push({ tool: tool.name, message: `--examples gives a value for "${safeText(tool.name, 60)}", but no cases could be made for that tool (${r.noCases ? "its input schema declares no properties" : "see skipped"})` });
    }
    if (r.cut) report.cut.push(r.cut);
    if (r.noCases) report.noCases.push(tool.name);
  }
}

function finish(report: McpCasesReport, options: GenerateOptions): McpCasesReport {
  const adv = report.adversarial;
  if (adv && report.adversarialLimits) {
    // The cap for the whole run: the first cases in the order of tool names stay.
    const room = report.adversarialLimits.maxPerRun;
    if (adv.length > room) {
      const lost = new Map<string, number>();
      for (const c of adv.slice(room)) lost.set(c.tool, (lost.get(c.tool) ?? 0) + 1);
      adv.length = room;
      for (const [tool, count] of lost) report.adversarialCut?.push({ tool, count, scope: "per-run" });
    }
    const o = options.adversarial;
    if (o?.styles.includes("hacker") && o.http?.authenticated) {
      const name = (o.allowTools ?? []).find((n) => report.cases.some((c) => c.tool === n && c.kind === "valid"));
      const valid = name === undefined ? undefined : report.cases.find((c) => c.tool === name && c.kind === "valid");
      if (valid) report.noCredentials = { tool: valid.tool, args: valid.args, expectAuth: o.expectAuth === true, sent: false };
    }
  }
  // One id per case, one name per case, in the whole run. Names that read the same (a tool name can hold " · ") also carry the id.
  const ids = new Set<string>();
  for (const c of [...report.cases, ...(report.adversarial ?? [])]) {
    if (ids.has(c.stableId)) throw new Error(`internal error: two cases share the id ${c.stableId} (${c.name})`);
    ids.add(c.stableId);
  }
  const labelCount = new Map<string, number>();
  for (const c of [...report.cases, ...(report.adversarial ?? [])]) labelCount.set(c.name, (labelCount.get(c.name) ?? 0) + 1);
  for (const c of [...report.cases, ...(report.adversarial ?? [])]) if ((labelCount.get(c.name) ?? 0) > 1) c.name = `${c.name} [${c.stableId}]`;
  return report;
}

/** Console lines. Everything that comes from the server goes through safeText. */
export function renderCasesSummary(report: McpCasesReport): string[] {
  const lines: string[] = [];
  const byTool = new Map<string, McpCase[]>();
  for (const c of report.cases) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
  const pos = report.cases.filter((c) => c.type === "Positive").length;
  const spent = report.skipped.filter((x) => x.keyword === "budget").length;
  lines.push(`Cases from inputSchema: ${report.cases.length} (${pos} positive, ${report.cases.length - pos} negative); nothing was sent.`);
  for (const [tool, list] of byTool) {
    const kinds: Record<string, number> = {};
    for (const c of list) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    lines.push(`  ${safeText(tool, 60)}: ${list.length} (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  }
  if (spent) lines.push(`  ${spent} tools skipped: ${BUDGET_SPENT_REASON}.`);
  for (const t of report.noCases) lines.push(`  ${safeText(t, 60)}: no cases (the input schema declares no properties).`);
  for (const c of report.cut) {
    lines.push(`  ${safeText(c.tool, 60)}: ${c.count} more cut at --max-cases-per-tool ${report.maxCasesPerTool} (${Object.entries(c.kinds).map(([k, n]) => `${k} ${n}`).join(", ")}).`);
  }
  if (report.adversarial && report.adversarialLimits) {
    const adv = report.adversarial;
    const by: Record<string, number> = {};
    for (const c of adv) by[c.style] = (by[c.style] ?? 0) + 1;
    lines.push(
      `Adversarial cases: ${adv.length} (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}); string length ${report.adversarialLimits.maxStringLength}, depth ${report.adversarialLimits.maxDepth}.`,
    );
    const human = adv.filter((c) => c.humanOracle).length;
    if (human) lines.push(`  ${human} of them need a human-defined oracle: whether the payload was handled safely is not decided by a rule.`);
    for (const c of report.adversarialCut ?? []) {
      lines.push(`  ${safeText(c.tool, 60)}: ${c.count} adversarial cases cut at the cap (${c.scope === "per-tool" ? `${report.adversarialLimits.maxPerTool} per tool` : `${report.adversarialLimits.maxPerRun} per run`}).`);
    }
    const advSkipped = report.skipped.filter((x) => x.kind === "adversarial").reduce((n, x) => n + (x.count ?? 1), 0);
    if (advSkipped) lines.push(`  ${advSkipped} adversarial cases skipped (see skipped).`);
    if (report.noCredentials) {
      lines.push(`  A call without credentials is described for ${safeText(report.noCredentials.tool, 60)} (once per server, not sent${report.noCredentials.expectAuth ? "; a pass would be a failure" : "; a pass would be a finding"}).`);
    }
  }
  if (report.skipped.length) {
    lines.push(`  Skipped (${report.skipped.length}):`);
    for (const s of report.skipped.slice(0, 20)) {
      lines.push(`    ${safeText(s.tool, 60)} · ${s.kind}${s.detail ? ` · ${safeText(s.detail, 60)}` : ""}: ${safeText(s.keyword, 40)} — ${safeText(s.reason, 160)}`);
    }
    if (report.skipped.length > 20) lines.push(`    … and ${report.skipped.length - 20} more (see ${CASES_FILE}).`);
  }
  return lines;
}

/** Cases whose arguments hold something the secret list masks are moved to `skipped`: a masked value would no longer match the schema. */
export function dropMaskedCases(report: McpCasesReport, secrets: readonly string[]): McpCasesReport {
  const keep: McpCase[] = [];
  const skipped = [...report.skipped];
  for (const c of report.cases) {
    const text = JSON.stringify(c.args);
    if (maskSecrets(text, secrets) === text) keep.push(c);
    else skipped.push({ tool: c.tool, kind: c.kind, detail: c.detail, keyword: "masked", reason: "value masked" });
  }
  const advKeep: McpAdversarialCase[] = [];
  for (const c of report.adversarial ?? []) {
    const text = JSON.stringify(c.args);
    if (maskSecrets(text, secrets) === text) advKeep.push(c);
    else skipped.push({ tool: c.tool, kind: "adversarial", detail: `${c.style} · ${c.kind}`, keyword: "masked", reason: "value masked" });
  }
  const out: McpCasesReport = { ...report, cases: keep, skipped, ...(report.adversarial ? { adversarial: advKeep } : {}) };
  if (report.noCredentials) {
    const text = JSON.stringify(report.noCredentials.args);
    if (maskSecrets(text, secrets) !== text) {
      delete out.noCredentials;
      skipped.push({ tool: report.noCredentials.tool, kind: "adversarial", detail: "no-credentials", keyword: "masked", reason: "value masked" });
    }
  }
  return out;
}
