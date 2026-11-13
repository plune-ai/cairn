/**
 * MCP-E2 — building values from a tool's `inputSchema` (JSON Schema, 2020-12).
 *
 * The schema comes from a foreign server, so it is untrusted input:
 * - nothing is ever fetched: a `$ref` that is not a local `#/...` pointer ends the tool as skipped;
 * - a cyclic `$ref`, a schema that is too deep or has too many nodes, and a string, array or number the generator cannot
 *   build within its limits end as a named reason, never as a hang;
 * - a `pattern` is never turned into a RegExp here to make a value. The generator builds a candidate by the rules
 *   below and the oracle (Ajv, 2020-12) decides whether it satisfies the schema. Ajv compiling the pattern is the only
 *   place a schema's regular expression runs.
 *
 * The generator does not need to understand every keyword. It builds the value it can and the oracle is the judge, so a
 * keyword it cannot satisfy (`pattern`, `not`, `uniqueItems`, ...) ends as a skipped case that names the keyword.
 */
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { safeText } from "./model.js";

export const SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
/** Nesting deeper than this, in the scan and in the generator, ends the tool. */
export const MAX_SCHEMA_DEPTH = 32;
/** More schema nodes than this (scan) or visited while building (generator) ends the tool. */
export const MAX_SCHEMA_NODES = 5000;
/** The longest string and the most items the generator builds. */
export const MAX_STRING_LENGTH = 256;
export const MAX_ARRAY_ITEMS = 64;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Why a schema (or a part of it) cannot be used, named by the keyword that is the cause. */
export class CannotBuild extends Error {
  constructor(
    readonly keyword: string,
    message: string,
  ) {
    super(message);
    this.name = "CannotBuild";
  }
}

/** Keys whose values are data, not schemas: not looked into for `$ref`. */
const DATA_KEYS = new Set(["const", "enum", "default", "examples", "example"]);

/**
 * Looks at the whole schema once, without recursion, before anything is built: a different draft, an external or dynamic
 * reference, too much nesting, too many nodes. Returns the problem, or undefined when the schema may be used.
 */
export function scanSchema(root: unknown): CannotBuild | undefined {
  if (!isObj(root)) return new CannotBuild("type", "the input schema is not an object");
  const declared = root["$schema"];
  if (declared !== undefined && declared !== SCHEMA_2020_12) {
    return new CannotBuild("$schema", `the schema declares $schema ${safeText(declared, 80)}; only ${SCHEMA_2020_12} is supported`);
  }
  let nodes = 0;
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (!node || typeof node !== "object") continue;
    if (++nodes > MAX_SCHEMA_NODES) return new CannotBuild("limit", `the schema has more than ${MAX_SCHEMA_NODES} nodes`);
    if (depth > MAX_SCHEMA_DEPTH) return new CannotBuild("limit", `the schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
    if (Array.isArray(node)) {
      for (const x of node) stack.push([x, depth + 1]);
      continue;
    }
    const o = node as Obj;
    for (const [k, v] of Object.entries(o)) {
      if (k === "$ref" && typeof v === "string") {
        if (!v.startsWith("#/") && v !== "#") return new CannotBuild("$ref", `the reference ${safeText(v, 80)} is not a local pointer; it is not loaded`);
        // A chain of references that leads back to itself says nothing; Ajv would overflow its stack on it.
        const seen = new Set<string>();
        let ref: string = v;
        for (let hop = 0; hop < 64; hop++) {
          if (seen.has(ref)) return new CannotBuild("$ref", `the reference ${safeText(v, 80)} is cyclic`);
          seen.add(ref);
          const target = pointer(root, ref);
          const next = isObj(target) ? target["$ref"] : undefined;
          if (typeof next !== "string" || (!next.startsWith("#/") && next !== "#")) break;
          ref = next;
        }
      } else if ((k === "$dynamicRef" || k === "$recursiveRef") && typeof v === "string") {
        return new CannotBuild(k, `${k} is not supported`);
      } else if (!DATA_KEYS.has(k)) {
        stack.push([v, depth + 1]);
      }
    }
  }
  return undefined;
}

export interface OracleResult {
  valid: boolean;
  /** The keyword of the first error, when the value is not valid. */
  keyword?: string;
  /** Where in the value the first error is. */
  path?: string;
}

export interface Oracle {
  check(value: unknown): OracleResult;
}

/** A validator for the schema (Ajv, 2020-12, with formats). Throws {@link CannotBuild} when it does not compile. */
export function compileOracle(schema: Obj): Oracle {
  // One instance per schema: two tools may declare the same `$id`.
  const ajv = new Ajv2020({ strict: false, allErrors: false, logger: false });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    throw new CannotBuild("schema", `the schema does not compile: ${safeText((e as Error).message, 200)}`);
  }
  return {
    check(value: unknown): OracleResult {
      if (validate(value)) return { valid: true };
      const first = (validate.errors ?? [])[0] as ErrorObject | undefined;
      return { valid: false, ...(first ? { keyword: first.keyword, path: first.instancePath } : {}) };
    },
  };
}

/** `#/a/b` → the node, or undefined. `~1` and `~0` and percent escapes are decoded. */
function pointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isObj(node)) node = Object.prototype.hasOwnProperty.call(node, seg) ? node[seg] : undefined;
    else return undefined;
  }
  return node;
}

const FORMATS: Record<string, string> = {
  email: "user@example.com",
  uuid: "00000000-0000-0000-0000-000000000000",
  date: "2024-01-01",
  "date-time": "2024-01-01T00:00:00Z",
  time: "00:00:00Z",
  uri: "https://example.com",
  url: "https://example.com",
  hostname: "example.com",
  ipv4: "127.0.0.1",
  ipv6: "::1",
};

/** Keywords of the object schema that stay when the branches of `oneOf`/`anyOf`/`allOf` are taken away. */
const COMPOSITION = ["oneOf", "anyOf", "allOf"] as const;

export class SchemaBuilder {
  private nodes = 0;

  constructor(readonly root: Obj) {}

  /** Follows `$ref`, then merges `allOf`: the schema as one object. Cyclic references throw {@link CannotBuild}. */
  view(raw: unknown, active: ReadonlySet<string> = new Set()): Obj {
    if (raw === true) return {};
    if (raw === false) throw new CannotBuild("false", "the schema is false: it accepts no value");
    if (!isObj(raw)) throw new CannotBuild("type", "a sub-schema is not an object");
    let node: Obj = raw;
    let seen = active;
    while (typeof node["$ref"] === "string") {
      const ref = node["$ref"];
      if (seen.has(ref)) throw new CannotBuild("$ref", `the reference ${safeText(ref, 80)} is cyclic`);
      const target = pointer(this.root, ref);
      if (target === undefined) throw new CannotBuild("$ref", `the reference ${safeText(ref, 80)} points to nothing`);
      if (target === true) {
        node = {};
      } else if (!isObj(target)) {
        throw new CannotBuild("$ref", `the reference ${safeText(ref, 80)} does not point to a schema`);
      } else {
        const { $ref: _ignored, ...siblings } = node;
        void _ignored;
        node = { ...target, ...siblings };
      }
      seen = new Set(seen).add(ref);
    }
    if (Array.isArray(node["allOf"]) && node["allOf"].length) {
      const { allOf, ...rest } = node;
      const parts = [rest, ...(allOf as unknown[]).map((p) => this.view(p, seen))];
      return this.combine(parts);
    }
    return node;
  }

  /** Merge views of the same value: properties joined, `required` united, any other keyword from the first that has it. */
  private combine(parts: Obj[]): Obj {
    const out: Obj = {};
    const properties: Obj = {};
    const required: string[] = [];
    for (const p of parts) {
      for (const [k, v] of Object.entries(p)) {
        if (k === "properties" && isObj(v)) {
          for (const [pk, pv] of Object.entries(v)) if (!(pk in properties)) properties[pk] = pv;
        } else if (k === "required" && Array.isArray(v)) {
          for (const r of v) if (typeof r === "string" && !required.includes(r)) required.push(r);
        } else if (!(k in out)) {
          out[k] = v;
        }
      }
    }
    if (Object.keys(properties).length) out["properties"] = properties;
    if (required.length) out["required"] = required;
    return out;
  }

  /** The `oneOf`/`anyOf` branches of a schema, as views merged with the keywords next to them. */
  branches(raw: unknown): Array<{ index: number; keyword: "oneOf" | "anyOf"; schema: Obj }> {
    const v = this.view(raw);
    const out: Array<{ index: number; keyword: "oneOf" | "anyOf"; schema: Obj }> = [];
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const list = v[keyword];
      if (!Array.isArray(list)) continue;
      const rest: Obj = { ...v };
      for (const c of COMPOSITION) delete rest[c];
      list.forEach((b, index) => out.push({ index, keyword, schema: this.combine([this.view(b), rest]) }));
    }
    return out;
  }

  /** One value for a schema, by the order const → examples → default → enum → type. */
  value(raw: unknown, depth = 0, active: ReadonlySet<string> = new Set()): unknown {
    if (++this.nodes > MAX_SCHEMA_NODES) throw new CannotBuild("limit", `more than ${MAX_SCHEMA_NODES} schema nodes were visited`);
    if (depth > MAX_SCHEMA_DEPTH) throw new CannotBuild("limit", `the schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
    const s = this.view(raw, active);
    if ("const" in s) return s["const"];
    if (Array.isArray(s["examples"]) && s["examples"].length) return s["examples"][0];
    if (s["default"] !== undefined) return s["default"];
    if (Array.isArray(s["enum"]) && s["enum"].length) return s["enum"][0];
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const list = s[keyword];
      if (Array.isArray(list) && list.length) {
        const rest: Obj = { ...s };
        for (const c of COMPOSITION) delete rest[c];
        return this.value(this.combine([this.view(list[0]), rest]), depth + 1, active);
      }
    }
    const type = this.typeOf(s);
    switch (type) {
      case "object":
        return this.object(s, depth);
      case "array":
        return this.array(s, depth);
      case "string":
        return this.string(s);
      case "integer":
      case "number":
        return this.number(s, type === "integer");
      case "boolean":
        return true;
      case "null":
        return null;
      default:
        return "value";
    }
  }

  private typeOf(s: Obj): string | undefined {
    const t = s["type"];
    if (typeof t === "string") return t;
    if (Array.isArray(t)) {
      const first = t.find((x) => typeof x === "string" && x !== "null");
      return typeof first === "string" ? first : t.includes("null") ? "null" : undefined;
    }
    if ("properties" in s || "required" in s) return "object";
    if ("items" in s || "prefixItems" in s || "minItems" in s || "maxItems" in s) return "array";
    if ("minLength" in s || "maxLength" in s || "pattern" in s || "format" in s) return "string";
    if ("minimum" in s || "maximum" in s || "exclusiveMinimum" in s || "exclusiveMaximum" in s || "multipleOf" in s) return "number";
    return undefined;
  }

  private object(s: Obj, depth: number): Obj {
    const out: Obj = {};
    const props = isObj(s["properties"]) ? s["properties"] : {};
    const required = Array.isArray(s["required"]) ? s["required"].filter((r): r is string => typeof r === "string") : [];
    for (const key of required) out[key] = key in props ? this.value(props[key], depth + 1) : "value";
    return out;
  }

  private array(s: Obj, depth: number): unknown[] {
    const prefix = Array.isArray(s["prefixItems"]) ? (s["prefixItems"] as unknown[]) : [];
    const min = typeof s["minItems"] === "number" ? s["minItems"] : 0;
    const count = Math.max(min, prefix.length);
    if (count > MAX_ARRAY_ITEMS) throw new CannotBuild("minItems", `the array needs ${count} items; the limit is ${MAX_ARRAY_ITEMS}`);
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) {
      if (i < prefix.length) out.push(this.value(prefix[i], depth + 1));
      else out.push(s["items"] === undefined ? "value" : this.value(s["items"], depth + 1));
    }
    return out;
  }

  /** A string of at least `minLength` characters, cut to `maxLength`. A `pattern` is not read: the oracle judges the result. */
  private string(s: Obj): string {
    let text = typeof s["format"] === "string" && s["format"] in FORMATS ? (FORMATS[s["format"]] as string) : "a";
    const min = typeof s["minLength"] === "number" ? s["minLength"] : 0;
    if (min > MAX_STRING_LENGTH) throw new CannotBuild("minLength", `the string needs ${min} characters; the limit is ${MAX_STRING_LENGTH}`);
    if (text.length < min) text = text.padEnd(min, "a");
    const max = typeof s["maxLength"] === "number" ? s["maxLength"] : Number.POSITIVE_INFINITY;
    return text.length > max ? text.slice(0, Math.max(0, max)) : text;
  }

  /** The number nearest to 0 that the bounds and `multipleOf` allow; the oracle judges the result. */
  private number(s: Obj, integer: boolean): number {
    const num = (k: string): number | undefined => (typeof s[k] === "number" ? (s[k] as number) : undefined);
    const min = num("minimum");
    const max = num("maximum");
    const exMin = num("exclusiveMinimum");
    const exMax = num("exclusiveMaximum");
    const lo = Math.max(min ?? Number.NEGATIVE_INFINITY, exMin ?? Number.NEGATIVE_INFINITY);
    const hi = Math.min(max ?? Number.POSITIVE_INFINITY, exMax ?? Number.POSITIVE_INFINITY);
    const step = integer ? 1 : 0.5;
    let v = 0;
    if (v < lo || (exMin !== undefined && v <= exMin)) v = exMin !== undefined && exMin >= (min ?? Number.NEGATIVE_INFINITY) ? exMin + step : lo;
    if (v > hi || (exMax !== undefined && v >= exMax)) v = exMax !== undefined && exMax <= (max ?? Number.POSITIVE_INFINITY) ? exMax - step : hi;
    const m = num("multipleOf");
    if (m !== undefined && m > 0) {
      const up = Math.ceil(v / m) * m;
      v = up <= hi ? up : Math.floor(v / m) * m;
    }
    if (integer) v = Math.ceil(v);
    return Number.isFinite(v) ? v : 0;
  }
}
