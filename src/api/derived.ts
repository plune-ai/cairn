/**
 * #228 / #229 — an OpenAPI 3.x document built from examples instead of a written spec.
 *
 * A Postman collection, a HAR file (#228) and the traffic recorded while exploring the UI (#229) all end here: each
 * request seen is an {@link Exchange}, the {@link DerivedSpecBuilder} folds them into operations (ids in the path
 * become parameters, body schemas are inferred from the examples), and {@link writeDerivedSpec} saves the result as
 * `openapi.derived.json`, which `ingestOpenApi` reads like any other spec. No format of our own: what cannot be
 * written as OpenAPI is not kept.
 *
 * What was inferred rather than described carries `x-cairn-derived: true` (the document, each operation, each body
 * schema), so whoever reads the spec knows to trust it less.
 *
 * Nothing secret is kept: header values, cookies, query values and body values never enter the document — only
 * names, types and status codes. The writer still scrubs the values a source marked as secret
 * ({@link exchangeSecrets}, built on `decider/redact.ts` and the api guard) in case one rode in a name or a path.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact, secretValues } from "../decider/redact.js";
import { secretShaped } from "../browser/click-effect.js";
import { collectSecrets, SENSITIVE } from "./guard.js";

/** The extension that marks what was inferred from examples. */
export const DERIVED_KEY = "x-cairn-derived";
/** The file name a derived spec is saved under in the run's directory. */
export const DERIVED_SPEC_FILE = "openapi.derived.json";

export type JsonSchema = Record<string, unknown>;

/** One request seen, as the builder takes it. Bodies are parsed values, read for their shape only and not kept. */
export interface Exchange {
  method: string;
  /** The path without query: `/projects/123`, `/projects/:id`, `/projects/{{id}}`, `/reset/‹v›`. */
  path: string;
  /** Names of the query parameters sent (their values are not taken). */
  queryKeys?: string[];
  /** The response status; absent when no answer was recorded. */
  status?: number;
  request?: { contentType?: string; body?: unknown };
  response?: { contentType?: string; body?: unknown };
  /** A name a person gave the request (a Postman item), and the folders it sits in. */
  summary?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** A path parameter of a templated path; `integer` when every value seen was digits. */
export interface PathParam {
  name: string;
  integer?: true;
}

const NAMED = [/^\{\{\s*([\w.-]+)\s*\}\}$/, /^:([A-Za-z_][\w-]*)$/, /^\{([A-Za-z_][\w.-]*)\}$/];

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Holds an e-mail address: `alice@example.com`, `mailto:bob@example.com`. */
const EMAIL = /[^\s@/]+@[^\s@/]+\.[A-Za-z]{2,}/;

/**
 * A name that is somebody's data, not the API's: an e-mail address or a credential-shaped run. In a path it becomes a
 * parameter; as an object key it makes the object a map; as a query name it is dropped. Never written as a name.
 */
export const personalName = (s: string): boolean => EMAIL.test(s) || secretShaped(s);

/** `projects` → `projectId`, `categories` → `categoryId`, `v2` (or nothing) → `id`. */
function nameFor(previous: string | undefined): string {
  if (!previous || !/^[A-Za-z][A-Za-z_-]*$/.test(previous)) return "id";
  const word = previous.replace(/[-_]+(\w)/g, (_, c: string) => c.toUpperCase());
  const one = /ies$/.test(word) ? `${word.slice(0, -3)}y` : /(?:ss|us)$/.test(word) ? word : word.replace(/s$/, "");
  return `${one.charAt(0).toLowerCase()}${one.slice(1)}Id`;
}

/**
 * The templated form of a path: a segment named as a parameter (`:id`, `{{id}}`, `{id}`) keeps its name; one that is
 * an id (digits, a UUID, long hex, a credential-shaped run, an e-mail address, a `‹v›` already put there) becomes a parameter named for
 * the segment before it (`/projects/123/tasks/9` → `/projects/{projectId}/tasks/{taskId}`), or `{id}` when it is the
 * only one. Words, slugs and `v2` stay.
 */
export function templatePath(path: string): { path: string; params: PathParam[] } {
  const segs = path.split("/").filter((s, i) => s !== "" || i === 0);
  type Seg = { literal: string } | { name?: string; integer: boolean };
  const parsed: Seg[] = segs.map((raw) => {
    const s = decoded(raw.split(";")[0] ?? "");
    for (const re of NAMED) {
      const m = re.exec(s);
      if (m?.[1]) return { name: m[1].replace(/[^\w-]/g, "_"), integer: false };
    }
    if (/^\d+$/.test(s)) return { integer: true };
    if (s === "‹v›" || s === "{}" || personalName(s)) return { integer: false };
    return { literal: s };
  });
  const count = parsed.filter((p) => !("literal" in p)).length;
  const used = new Set<string>();
  const params: PathParam[] = [];
  const out = parsed.map((p, i) => {
    if ("literal" in p) return p.literal;
    const prev = parsed[i - 1];
    let name = p.name ?? (count === 1 ? "id" : nameFor(prev && "literal" in prev ? prev.literal : undefined));
    for (let n = 2; used.has(name); n++) name = `${p.name ?? "id"}${n}`;
    used.add(name);
    params.push(p.integer ? { name, integer: true } : { name });
    return `{${name}}`;
  });
  const joined = out.join("/");
  return { path: joined.startsWith("/") ? joined : `/${joined}`, params };
}

// ---------------------------------------------------------------------------------------------------------------
// Schemas

const MAX_DEPTH = 8;
const MAX_ITEMS = 50;
const MAX_KEYS = 200;

/**
 * The JSON schema of one example value: types, object keys (all `required`) and array items — never the value. A
 * `null` gives `{ nullable: true }` with no type, so a later example can say what the type is. An empty array has no
 * `items` yet for the same reason. An object with a key that is an e-mail address or credential-shaped is a map keyed by
 * people or tokens: its schema is `additionalProperties` with the values' merged schema, and no key is kept.
 */
export function schemaOf(v: unknown, depth = 0): JsonSchema {
  if (v === null) return { nullable: true };
  if (depth > MAX_DEPTH) return {};
  if (Array.isArray(v)) {
    let items: JsonSchema | undefined;
    for (const x of v.slice(0, MAX_ITEMS)) {
      const s = schemaOf(x, depth + 1);
      items = items ? mergeSchema(items, s) : s;
    }
    return items ? { type: "array", items } : { type: "array" };
  }
  switch (typeof v) {
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: Number.isInteger(v) ? "integer" : "number" };
    case "string":
      return { type: "string" };
    case "object": {
      const all = Object.keys(v as object);
      if (all.some(personalName)) {
        let values: JsonSchema | undefined;
        for (const k of all.slice(0, MAX_KEYS)) {
          const s = schemaOf((v as Record<string, unknown>)[k], depth + 1);
          values = values ? mergeSchema(values, s) : s;
        }
        return { type: "object", additionalProperties: values ?? {} };
      }
      const keys = all.slice(0, MAX_KEYS);
      const properties: Record<string, JsonSchema> = {};
      for (const k of keys) properties[k] = schemaOf((v as Record<string, unknown>)[k], depth + 1);
      return keys.length ? { type: "object", properties, required: keys } : { type: "object" };
    }
    default:
      return {};
  }
}

/** Two examples' schemas as one: keys of either, `required` only when in both, `integer` + `number` is `number`, a
 * `null` makes it `nullable`, and two types that do not agree make it anything (`{}`). A map merged with an object is
 * a map whose values take every value seen. */
export function mergeSchema(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (Object.keys(a).length === 0 || Object.keys(b).length === 0) return {};
  if (a.type === undefined) return b.type === undefined ? { nullable: true } : { ...b, nullable: true };
  if (b.type === undefined) return { ...a, nullable: true };
  const nullable = a.nullable === true || b.nullable === true;
  let out: JsonSchema;
  if (a.type === b.type && a.type === "object" && (a.additionalProperties !== undefined || b.additionalProperties !== undefined)) {
    const values = [a, b].flatMap((x) => [
      ...(x.additionalProperties !== undefined ? [x.additionalProperties as JsonSchema] : []),
      ...Object.values((x.properties ?? {}) as Record<string, JsonSchema>),
    ]);
    out = { type: "object", additionalProperties: values.reduce((m, x) => mergeSchema(m, x)) };
  } else if (a.type === b.type && a.type === "object") {
    const pa = (a.properties ?? {}) as Record<string, JsonSchema>;
    const pb = (b.properties ?? {}) as Record<string, JsonSchema>;
    const properties: Record<string, JsonSchema> = { ...pa };
    for (const [k, s] of Object.entries(pb)) properties[k] = pa[k] ? mergeSchema(pa[k], s) : s;
    const rb = new Set((b.required ?? []) as string[]);
    const required = ((a.required ?? []) as string[]).filter((k) => rb.has(k));
    out = { type: "object", ...(Object.keys(properties).length ? { properties } : {}), ...(required.length ? { required } : {}) };
  } else if (a.type === b.type && a.type === "array") {
    const ia = a.items as JsonSchema | undefined;
    const ib = b.items as JsonSchema | undefined;
    const items = ia && ib ? mergeSchema(ia, ib) : (ia ?? ib);
    out = items ? { type: "array", items } : { type: "array" };
  } else if (a.type === b.type) {
    out = { type: a.type };
  } else if ((a.type === "integer" || a.type === "number") && (b.type === "integer" || b.type === "number")) {
    out = { type: "number" };
  } else {
    return {};
  }
  return nullable ? { ...out, nullable: true } : out;
}

/** Ready for the document: an array with no item seen takes any items, a value only ever `null` is left open (not
 * pinned to `null`), and the top is marked derived. */
function finalSchema(s: JsonSchema, top = true): JsonSchema {
  let out: JsonSchema = { ...s };
  if (out.type === undefined) out = {};
  if (out.type === "array") out.items = out.items ? finalSchema(out.items as JsonSchema, false) : {};
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = finalSchema(out.additionalProperties as JsonSchema, false);
  }
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, JsonSchema>).map(([k, v]) => [k, finalSchema(v, false)]),
    );
  }
  return top ? { ...out, [DERIVED_KEY]: true } : out;
}

// ---------------------------------------------------------------------------------------------------------------
// Traffic

const STATIC_TYPES = new Set(["document", "stylesheet", "script", "image", "font", "media", "manifest", "texttrack", "imageset"]);
const STATIC_MIME = /^(?:text\/(?:html|css|javascript|vtt)|(?:application|text)\/(?:x-)?(?:java|ecma)script|image\/|font\/|audio\/|video\/|application\/(?:font|x-font|wasm|manifest\+json|vnd\.ms-fontobject))/i;
const STATIC_EXT = /\.(?:m?js|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|html?|wasm)$/i;

/** A request the application's API answers — not a page, a script, a style, an image, a font or a media file. */
export function isApiTraffic(r: { url: string; resourceType?: string; mimeType?: string }): boolean {
  if (r.resourceType && STATIC_TYPES.has(r.resourceType.toLowerCase())) return false;
  if (r.mimeType && STATIC_MIME.test(r.mimeType.trim())) return false;
  let path: string;
  try {
    path = new URL(r.url).pathname;
  } catch {
    path = r.url.split(/[?#]/)[0] ?? "";
  }
  return !STATIC_EXT.test(path);
}

/** `application/json; charset=utf-8` → `application/json`. */
export function mediaType(contentType: string | undefined): string | undefined {
  const t = contentType?.split(";")[0]?.trim().toLowerCase();
  return t ? t : undefined;
}

/** A media type whose body is read as JSON (`application/json`, `application/problem+json`, `…+json`). */
export const isJsonMedia = (t: string | undefined): boolean => t !== undefined && /[/+]json$/.test(t);

// ---------------------------------------------------------------------------------------------------------------
// The document

interface Op {
  method: string;
  path: string;
  params: { name: string; integer: boolean }[];
  query: Set<string>;
  summary?: string;
  tags: Set<string>;
  seen: number;
  withBody: number;
  requestBodies: Map<string, JsonSchema | undefined>;
  responses: Map<string, Map<string, JsonSchema | undefined>>;
}

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const merged = (prev: JsonSchema | undefined, next: JsonSchema | undefined, had: boolean): JsonSchema | undefined =>
  !had ? next : prev && next ? mergeSchema(prev, next) : (prev ?? next);

/** Folds {@link Exchange}s into OpenAPI operations one at a time, so nothing but the merged shapes is held. */
export class DerivedSpecBuilder {
  private readonly ops = new Map<string, Op>();

  /** How many operations the requests added so far make. */
  get size(): number {
    return this.ops.size;
  }

  add(x: Exchange): void {
    const method = x.method.toLowerCase();
    if (!METHODS.has(method)) return;
    const t = templatePath(x.path);
    const shape = t.path.replace(/\{[^}]*\}/g, "{}");
    const key = `${method} ${shape}`;
    let op = this.ops.get(key);
    if (!op) {
      op = {
        method,
        path: t.path,
        params: t.params.map((p) => ({ name: p.name, integer: p.integer === true })),
        query: new Set(),
        tags: new Set(),
        seen: 0,
        withBody: 0,
        requestBodies: new Map(),
        responses: new Map(),
      };
      this.ops.set(key, op);
    } else {
      // A path parameter is an integer only while every value seen was one.
      t.params.forEach((p, i) => {
        if (op!.params[i] && !p.integer) op!.params[i]!.integer = false;
      });
    }
    op.seen += 1;
    for (const q of x.queryKeys ?? []) if (q && !personalName(q)) op.query.add(q);
    if (op.summary === undefined && x.summary) op.summary = x.summary;
    for (const tag of x.tags ?? []) op.tags.add(tag);
    const reqType = mediaType(x.request?.contentType);
    if (x.request && (reqType || x.request.body !== undefined)) {
      op.withBody += 1;
      const mt = reqType ?? "application/json";
      const s = x.request.body !== undefined ? schemaOf(x.request.body) : undefined;
      op.requestBodies.set(mt, merged(op.requestBodies.get(mt), s, op.requestBodies.has(mt)));
    }
    if (x.status !== undefined && x.status >= 100 && x.status <= 599) {
      const status = String(x.status);
      const media = op.responses.get(status) ?? new Map<string, JsonSchema | undefined>();
      op.responses.set(status, media);
      const resType = mediaType(x.response?.contentType);
      const body = x.response?.body;
      if (resType && body !== undefined) media.set(resType, merged(media.get(resType), schemaOf(body), media.has(resType)));
    }
  }

  /** The OpenAPI 3.0.3 document, paths and methods in a stable order. */
  toOpenApi(info: { title: string; version?: string; description?: string }, servers: string[] = []): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    const ops = [...this.ops.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    for (const op of ops) {
      const item = (paths[op.path] ??= {});
      const parameters = [
        ...op.params.map((p) => ({ name: p.name, in: "path", required: true, schema: { type: p.integer ? "integer" : "string" } })),
        ...[...op.query].sort().map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
      ];
      const responses: Record<string, unknown> = {};
      for (const [status, media] of [...op.responses].sort(([a], [b]) => a.localeCompare(b))) {
        const content = Object.fromEntries([...media].map(([mt, s]) => [mt, s ? { schema: finalSchema(s) } : {}]));
        responses[status] = { description: `Status ${status}, as recorded`, ...(media.size ? { content } : {}) };
      }
      if (Object.keys(responses).length === 0) responses.default = { description: "No response was recorded" };
      item[op.method] = {
        ...(op.summary ? { summary: op.summary } : {}),
        ...(op.tags.size ? { tags: [...op.tags] } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(op.requestBodies.size
          ? {
              requestBody: {
                required: op.withBody === op.seen,
                content: Object.fromEntries([...op.requestBodies].map(([mt, s]) => [mt, s ? { schema: finalSchema(s) } : {}])),
              },
            }
          : {}),
        responses,
        [DERIVED_KEY]: true,
      };
    }
    return {
      openapi: "3.0.3",
      info: { title: info.title, version: info.version ?? "0.0.0", ...(info.description ? { description: info.description } : {}) },
      ...(servers.length ? { servers: servers.map((url) => ({ url })) } : {}),
      paths,
      [DERIVED_KEY]: true,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets and the file

/** Headers that are never written, whatever their value: the request's credentials and the cookies set back. */
export const DROPPED_HEADERS = /^(?:authorization|proxy-authorization|cookie|set-cookie|set-cookie2)$/i;

/**
 * The values a source carried that must not reach the file: every value of `Authorization`, `Cookie` and
 * `Set-Cookie` and of other sensitive headers (the credential after `Bearer `, each cookie value — the api guard's
 * {@link collectSecrets}), the values `decider/redact.ts` reads as secrets from `name: value` pairs (query, form and
 * body fields, variables: `password: …`, `api_key: …`), and any value shaped like a credential (a JWT, long hex).
 */
export function exchangeSecrets(input: { headers?: [string, string][]; fields?: [string, string][] }): string[] {
  const out = new Set<string>();
  const lines: string[] = [];
  const shaped = (v: string): void => {
    for (const t of v.split(/[\s,;&=]+/)) if (t.length >= 8 && secretShaped(t)) out.add(t);
  };
  for (const [name, value] of input.headers ?? []) {
    if (DROPPED_HEADERS.test(name) || SENSITIVE.test(name)) for (const s of collectSecrets({ [name]: value })) out.add(s);
    else lines.push(`${name}: ${value}`);
    shaped(value);
  }
  for (const [name, value] of input.fields ?? []) {
    if (SENSITIVE.test(name) && value.trim().length >= 4) out.add(value.trim());
    lines.push(`${name}: ${value}`);
    shaped(value);
  }
  for (const s of secretValues(lines.join("\n"), {})) out.add(s);
  return [...out].sort((a, b) => b.length - a.length);
}

/** String leaves of a parsed body with their keys — `{ user: { password: "x" } }` → `[["password", "x"]]`. */
export function bodyFields(v: unknown, key = "body", out: [string, string][] = [], depth = 0): [string, string][] {
  if (depth > MAX_DEPTH || out.length > 500) return out;
  if (typeof v === "string") out.push([key, v]);
  else if (typeof v === "number" || typeof v === "boolean") out.push([key, String(v)]);
  else if (Array.isArray(v)) for (const x of v.slice(0, MAX_ITEMS)) bodyFields(x, key, out, depth + 1);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) bodyFields(x, k, out, depth + 1);
  return out;
}

/**
 * Save a derived spec as `openapi.derived.json` in `dir` and return its path. The text is scrubbed of `secrets`
 * (raw and JSON-escaped, `decider/redact.ts`'s {@link redact}) before it is written.
 */
export async function writeDerivedSpec(dir: string, doc: Record<string, unknown>, secrets: readonly string[]): Promise<string> {
  const all = [...new Set(secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]))]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length);
  const text = redact(JSON.stringify(doc, null, 2), all);
  await mkdir(dir, { recursive: true });
  const file = join(dir, DERIVED_SPEC_FILE);
  await writeFile(file, `${text}\n`, "utf8");
  return file;
}
