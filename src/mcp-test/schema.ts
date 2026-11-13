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
import { createRequire } from "node:module";
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { safeText } from "./model.js";

export const SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
/** Nesting deeper than this, in the scan and in the generator, ends the tool. */
export const MAX_SCHEMA_DEPTH = 32;
/** More schema nodes than this (scan) or visited while building (generator) ends the tool. */
export const MAX_SCHEMA_NODES = 5000;
/** More branches than this in one oneOf/anyOf/allOf end the tool: Ajv overflows its stack on very wide lists. */
export const MAX_BRANCHES = 100;
/** The longest string and the most items the generator builds. */
export const MAX_STRING_LENGTH = 256;
export const MAX_ARRAY_ITEMS = 64;
/** The most a tool's input schema may weigh once written as JSON. Over it, the tool is skipped before anything looks at it. */
export const MAX_SCHEMA_BYTES = 256 * 1024;
/** The time one tool's schema check (compile and every validation) may take. */
export const ORACLE_TIME_LIMIT_MS = 2000;
/** The time the checking worker may take to start (no schema is involved yet). */
const WORKER_START_LIMIT_MS = 10000;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** Names that come from a server index plain objects only through these two. */
export const has = (o: object, k: string): boolean => Object.hasOwn(o, k);
export function put(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

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

/** The schema check of a tool ran out of time; the tool is dropped. */
export class OracleTimeout extends CannotBuild {}

/** Keys whose values are data, not schemas: not looked into for `$ref`. */
const DATA_KEYS = new Set(["const", "enum", "default", "examples", "example"]);
/** Keywords whose value is a map from NAMES to schemas: inside it every key is a name, not a keyword. */
const NAME_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
const isLocalRef = (v: string): boolean => v === "#" || v.startsWith("#/");

/**
 * Looks at the whole schema once, without recursion, before anything is built: a different draft, an external or dynamic
 * reference, too much nesting, too many nodes, too many branches. Returns the problem, or undefined when the schema may be used.
 */
export function scanSchema(root: unknown): CannotBuild | undefined {
  if (!isObj(root)) return new CannotBuild("type", "the input schema is not an object");
  try {
    const bytes = JSON.stringify(root).length;
    if (bytes > MAX_SCHEMA_BYTES) return new CannotBuild("limit", `the input schema is ${bytes} bytes; the limit is ${MAX_SCHEMA_BYTES} bytes`);
  } catch {
    return new CannotBuild("limit", "the input schema is too deeply nested to be measured");
  }
  const declared = root["$schema"];
  if (declared !== undefined && declared !== SCHEMA_2020_12 && declared !== `${SCHEMA_2020_12}#`) {
    return new CannotBuild("$schema", `the schema declares $schema ${safeText(declared, 80)}; only ${SCHEMA_2020_12} is supported`);
  }
  let nodes = 0;
  const stack: Array<[unknown, number, boolean]> = [[root, 0, false]];
  while (stack.length) {
    const [node, depth, isNameMap] = stack.pop() as [unknown, number, boolean];
    if (!node || typeof node !== "object") continue;
    if (++nodes > MAX_SCHEMA_NODES) return new CannotBuild("limit", `the schema has more than ${MAX_SCHEMA_NODES} nodes`);
    if (depth > MAX_SCHEMA_DEPTH) return new CannotBuild("limit", `the schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
    if (Array.isArray(node)) {
      for (const x of node) stack.push([x, depth + 1, false]);
      continue;
    }
    const o = node as Obj;
    if (isNameMap) {
      // Every key here is a name chosen by the server (even `default` or `$ref`); only the value is a schema.
      for (const v of Object.values(o)) stack.push([v, depth + 1, false]);
      continue;
    }
    for (const [k, v] of Object.entries(o)) {
      if ((k === "oneOf" || k === "anyOf" || k === "allOf") && Array.isArray(v) && v.length > MAX_BRANCHES) {
        return new CannotBuild(k, `${k} has ${v.length} branches; the limit is ${MAX_BRANCHES}`);
      }
      if (NAME_MAPS.has(k) && isObj(v)) {
        stack.push([v, depth + 1, true]);
      } else if (k === "$ref" && typeof v === "string") {
        if (!isLocalRef(v)) return new CannotBuild("$ref", `the reference ${safeText(v, 80)} is not a local pointer; it is not loaded`);
        // A chain of references that leads back to itself says nothing; Ajv would overflow its stack on it.
        const seen = new Set<string>();
        let ref: string = v;
        for (let hop = 0; hop < 64; hop++) {
          if (seen.has(ref)) return new CannotBuild("$ref", `the reference ${safeText(v, 80)} is cyclic`);
          seen.add(ref);
          const target = pointer(root, ref);
          const next = isObj(target) ? target["$ref"] : undefined;
          if (typeof next !== "string" || !isLocalRef(next)) break;
          ref = next;
        }
      } else if ((k === "$dynamicRef" || k === "$recursiveRef") && typeof v === "string") {
        return new CannotBuild(k, `${k} is not supported`);
      } else if (!DATA_KEYS.has(k)) {
        stack.push([v, depth + 1, false]);
      }
    }
  }
  return undefined;
}

export interface OracleError {
  keyword: string;
  /** Where in the value the error is (JSON pointer). */
  path: string;
  /** For `required`: the missing property. */
  missing?: string;
}

export interface OracleResult {
  valid: boolean;
  /** The keyword of the first error, when the value is not valid. */
  keyword?: string;
  /** Where in the value the first error is. */
  path?: string;
  /** Every error (the check collects all of them). */
  errors: OracleError[];
}

export interface Oracle {
  /** Throws {@link CannotBuild} when the validator cannot run (stack overflow) and {@link OracleTimeout} when it takes too long. */
  check(value: unknown): OracleResult;
}

/** The compile-and-validate code shared by the in-process oracle and the worker (as text, so it can be run in both). */
const CHECK_SOURCE = `
function toResult(validate, value) {
  if (validate(value)) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map((e) => {
    const r = { keyword: e.keyword, path: e.instancePath };
    if (e.keyword === "required" && e.params && typeof e.params.missingProperty === "string") r.missing = e.params.missingProperty;
    return r;
  });
  const first = errors[0];
  return { valid: false, keyword: first && first.keyword, path: first && first.path, errors };
}`;

const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { ajvPath, formatsPath, port, flag } = workerData;
const A = require(ajvPath);
const Ajv2020 = A.Ajv2020 || A.default || A;
const F = require(formatsPath);
const addFormats = F.default || F;
${CHECK_SOURCE}
const sig = new Int32Array(flag);
const reply = (m) => { port.postMessage(m); Atomics.store(sig, 0, 1); Atomics.notify(sig, 0); };
let validate;
port.on("message", (msg) => {
  if (msg.init) return reply({ ok: true });
  if (msg.schema) {
    try {
      const ajv = new Ajv2020({ strict: false, allErrors: true, ownProperties: true, logger: false });
      addFormats(ajv);
      validate = ajv.compile(msg.schema);
      return reply({ ok: true });
    } catch (e) {
      return reply({ ok: false, overflow: e instanceof RangeError, message: String(e && e.message) });
    }
  }
  try { reply({ ok: true, result: toResult(validate, msg.value) }); }
  catch (e) { reply({ ok: false, overflow: e instanceof RangeError, message: String(e && e.message) }); }
});`;

function compileFailure(e: unknown): CannotBuild {
  if (e instanceof RangeError) return new CannotBuild("limit", "the schema is too deeply nested for the validator");
  return new CannotBuild("schema", `the schema does not compile: ${safeText((e as Error).message, 200)}`);
}

/** The schema as Ajv gets it: without `$schema` (the scan already checked it), so either spelling of the 2020-12 URI compiles. */
function forAjv(schema: Obj): Obj {
  const copy: Obj = {};
  for (const [k, v] of Object.entries(schema)) if (k !== "$schema") put(copy, k, v);
  return copy;
}

type Reply = { ok: boolean; overflow?: boolean; message?: string; result?: OracleResult } | undefined;

/** One worker thread; replaced, never reused, after a timeout. */
interface Live {
  worker: Worker;
  port: MessagePort;
  sig: Int32Array;
}

/**
 * Where the schema checks of one run happen. Every check of every tool runs in one worker thread: a RegExp in a schema
 * cannot be interrupted where it runs, but a worker can be terminated, and no test of the schema (not even a look for the
 * word `pattern`) decides whether a check is safe to run here. One time limit applies to each tool (compile and every
 * validation). After a timeout the worker is terminated and the next tool gets a new one.
 *
 * The worker is an inline script (a string): the package is compiled with plain `tsc`, which would not copy a separate
 * worker file, and the script gets the absolute paths of the two libraries from this module's own resolution, so it needs
 * no working directory. The script holds nothing that came from a server.
 */
export class OracleHost {
  private live: Live | undefined;
  private kills = 0;

  /** Counts the times the worker was stopped; a validator made before the last stop is gone. */
  get generation(): number {
    return this.kills;
  }

  private start(): Live {
    const req = createRequire(import.meta.url);
    const { port1, port2 } = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { ajvPath: req.resolve("ajv/dist/2020.js"), formatsPath: req.resolve("ajv-formats"), port: port2, flag },
      transferList: [port2],
    });
    worker.unref();
    worker.on("error", () => {}); // a worker that fails to start shows up as a start timeout below
    const live: Live = { worker, port: port1, sig: new Int32Array(flag) };
    this.live = live;
    if (!this.ask(live, { init: true }, WORKER_START_LIMIT_MS)) {
      this.kill(live);
      throw new CannotBuild("pattern", "the checking worker did not start");
    }
    return live;
  }

  private kill(live: Live): void {
    this.kills += 1;
    void live.worker.terminate();
    live.port.close();
    if (this.live === live) this.live = undefined;
  }

  private ask(live: Live, msg: unknown, ms: number): Reply {
    if (this.live !== live || ms <= 0) return undefined;
    Atomics.store(live.sig, 0, 0);
    live.port.postMessage(msg);
    if (Atomics.wait(live.sig, 0, 0, ms) === "timed-out") return undefined;
    return receiveMessageOnPort(live.port)?.message as Reply;
  }

  /** A validator for the schema (Ajv, 2020-12, with formats). Throws {@link CannotBuild} when it does not compile. */
  oracle(schema: Obj, opts: { perCheck?: boolean } = {}): Oracle {
    const live = this.live ?? this.start();
    const deadline = Date.now() + ORACLE_TIME_LIMIT_MS;
    const timeout = (): OracleTimeout => {
      this.kill(live);
      return new OracleTimeout("pattern", `the schema check took too long (more than ${ORACLE_TIME_LIMIT_MS} ms; a pattern may backtrack badly), so the tool was skipped`);
    };
    const compiled = this.ask(live, { schema: forAjv(schema) }, deadline - Date.now());
    if (!compiled) throw timeout();
    if (!compiled.ok) {
      throw compiled.overflow ? compileFailure(new RangeError()) : new CannotBuild("schema", `the schema does not compile: ${safeText(compiled.message, 200)}`);
    }
    return {
      check: (value: unknown): OracleResult => {
        // `perCheck`: a validator kept for a whole run gives every check its own time, not what is left of the first 2 s.
        const r = this.ask(live, { value }, opts.perCheck ? ORACLE_TIME_LIMIT_MS : deadline - Date.now());
        if (!r) throw timeout();
        if (!r.ok || !r.result) throw compileFailure(r.overflow ? new RangeError() : new Error(r.message));
        return r.result;
      },
    };
  }

  close(): void {
    if (this.live) this.kill(this.live);
  }
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
          for (const [pk, pv] of Object.entries(v)) if (!has(properties, pk)) put(properties, pk, pv);
        } else if (k === "required" && Array.isArray(v)) {
          for (const r of v) if (typeof r === "string" && !required.includes(r)) required.push(r);
        } else if (!has(out, k)) {
          put(out, k, v);
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
    for (const key of required) put(out, key, has(props, key) ? this.value(props[key], depth + 1) : "value");
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
    let text = typeof s["format"] === "string" && has(FORMATS, s["format"]) ? (FORMATS[s["format"]] as string) : "a";
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

/** True for `type: "integer"` and for a type list that has integer but not number. */
export function isIntegerType(schema: Obj): boolean {
  const t = schema["type"];
  return t === "integer" || (Array.isArray(t) && t.includes("integer") && !t.includes("number"));
}
