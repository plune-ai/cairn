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
 * Whatever the traffic says, the file holds a string that came from it only when that string has passed a fixed form
 * that a free-text value cannot have: a name ({@link isName}), a word of a path ({@link isPathWord}) or a media type
 * ({@link writtenMedia}). Anything else is dropped or becomes a parameter. A wrong fold costs one route in a draft, a
 * wrong keep costs someone's data, so when unsure it folds. A plain word has that form too, and no form tells a one-off
 * slug from a word of the API: {@link KnownValues} catches the ones the traffic shows to be values, the rest stay, and
 * the docs say so. Bodies, headers, cookies and query values are read for their shape and their values, and not kept.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { secretValues } from "../decider/redact.js";
import { caseFlips, secretShaped } from "../browser/click-effect.js";
import { collectSecrets, SENSITIVE } from "./guard.js";

/** The extension that marks what was inferred from examples. */
export const DERIVED_KEY = "x-cairn-derived";
/** The file name a derived spec is saved under in the run's directory. */
export const DERIVED_SPEC_FILE = "openapi.derived.json";

export type JsonSchema = Record<string, unknown>;

/** One request seen, as the builder takes it. Bodies are parsed values, read for their shape and their values and not kept. */
export interface Exchange {
  method: string;
  /** The path without query: `/projects/123`, `/projects/:id`, `/projects/{{id}}`, `/reset/‹v›`. */
  path: string;
  /** Names of the query parameters sent. */
  queryKeys?: string[];
  /** The response status; absent when no answer was recorded. */
  status?: number;
  request?: { contentType?: string; body?: unknown };
  response?: { contentType?: string; body?: unknown };
  /** The path was written by a person (a Postman item): `:id` and `{{id}}` in it are parameters, not traffic. */
  authored?: boolean;
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

/** The form of a name: a JSON key, a form field, a query name. No dot: a dotted name reads like a domain. */
const NAME_FORM = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** Long random text in a name: long hex, letters that flip case like random text, no vowel, digits all through it. */
function randomName(s: string): boolean {
  const run = s.replace(/[-_]/g, "");
  if (run.length >= 16 && (/^[0-9a-f]+$/i.test(run) || caseFlips(run) >= run.length / 3)) return true;
  if (run.length >= 8 && !/[aeiouy]/i.test(run)) return true;
  return (run.match(/\d+/g)?.length ?? 0) >= 3;
}

/** A string that may be written as a name. `address1`, `base64data`, `sha256sum` are; `user.name` and `Alice Smith` are not. */
export const isName = (s: string): boolean => s.length <= 64 && NAME_FORM.test(s) && !randomName(s);

const WORD_FORM = /^[A-Za-z]+\d*(?:[-_][A-Za-z]+\d*)*$/;

/**
 * A word that may stay in a path: per `-`/`_` separated part ASCII letters, with digits only at the end (`v1`, `oauth2`,
 * `s3`; not `a1b2c3d`). Not hex-only of 6 or more (`deadbeef`), no part of 5 or more letters without a vowel, not longer
 * than 32, and not credential-shaped ({@link secretShaped}). The length comes first: no regex sees a long value.
 */
export function isPathWord(s: string): boolean {
  if (s.length > 32 || !WORD_FORM.test(s) || /^[0-9a-f]{6,}$/i.test(s) || secretShaped(s)) return false;
  return s.split(/[-_]/).every((part) => {
    const letters = part.replace(/\d+$/, "");
    return letters.length < 5 || /[aeiouy]/i.test(letters);
  });
}

/**
 * The `name=value` parts of a query or a form body, decoded. A part with no `=` has no name at all: `?bare`, a text body
 * or a JSON body sent as a form. It comes back in `bare`, as a value.
 */
export function formParts(text: string): { fields: [string, string][]; bare: string[] } {
  const dec = (s: string): string => decoded(s.replace(/\+/g, " "));
  const fields: [string, string][] = [];
  const bare: string[] = [];
  for (const part of text.split("&")) {
    const eq = part.indexOf("=");
    if (eq >= 0) fields.push([dec(part.slice(0, eq)), dec(part.slice(eq + 1))]);
    else if (part) bare.push(dec(part));
  }
  return { fields, bare };
}

/** `projects` → `projectId`, `categories` → `categoryId`, `v2` (or nothing) → `id`. */
function nameFor(previous: string | undefined): string {
  if (!previous || !/^[A-Za-z][A-Za-z_-]*$/.test(previous)) return "id";
  const word = previous.replace(/[-_]+(\w)/g, (_, c: string) => c.toUpperCase());
  const one = /ies$/.test(word) ? `${word.slice(0, -3)}y` : /(?:ss|us)$/.test(word) ? word : word.replace(/s$/, "");
  return `${one.charAt(0).toLowerCase()}${one.slice(1)}Id`;
}

/** One place of a path: a word that may stay, or a parameter (with the name a person gave it, if one did). */
type Seg = { literal: string } | { name?: string; integer: boolean };
const isLiteral = (s: Seg): s is { literal: string } => "literal" in s;
const shapeOf = (segs: Seg[]): string => segs.map((s) => (isLiteral(s) ? s.literal : "{}")).join("/");

function segmentsOf(path: string, authored: boolean): Seg[] {
  return path
    .split("/")
    .filter((s, i) => s !== "" || i === 0)
    .map((raw, i): Seg => {
      if (i === 0 && raw === "") return { literal: "" }; // what makes the leading `/`
      const s = decoded(raw.split(";")[0] ?? "");
      if (authored) {
        for (const re of NAMED) {
          const m = re.exec(s);
          if (m?.[1]) return { name: m[1].replace(/[^\w-]/g, "_"), integer: false };
        }
      }
      if (/^\d+$/.test(s)) return { integer: true };
      return isPathWord(s) ? { literal: s } : { integer: false };
    });
}

/**
 * The written form of a path. A parameter a person named keeps its name. Any other takes its name only from the word
 * before it, when that word stayed in the path (`/projects/123/tasks/9` → `/projects/{projectId}/tasks/{taskId}`), and
 * is `{id}` otherwise or when it is the only one; numbered when repeated.
 */
function written(segs: Seg[]): { path: string; params: PathParam[] } {
  const count = segs.filter((s) => !isLiteral(s)).length;
  const used = new Set<string>();
  const params: PathParam[] = [];
  const out = segs.map((p, i) => {
    if (isLiteral(p)) return p.literal;
    const prev = segs[i - 1];
    let name = p.name ?? (count === 1 ? "id" : nameFor(prev && isLiteral(prev) ? prev.literal : undefined));
    for (let n = 2; used.has(name); n++) name = `${p.name ?? "id"}${n}`;
    used.add(name);
    params.push(p.integer ? { name, integer: true } : { name });
    return `{${name}}`;
  });
  const joined = out.join("/");
  return { path: joined.startsWith("/") ? joined : `/${joined}`, params };
}

/**
 * The templated form of one path, seen alone. `authored`: a segment named as a parameter (`:id`, `{{id}}`, `{id}`) keeps
 * its name; in recorded traffic such a segment is a value like any other.
 */
export function templatePath(path: string, authored = true): { path: string; params: PathParam[] } {
  return written(segmentsOf(path, authored));
}

// ---------------------------------------------------------------------------------------------------------------
// Schemas

const MAX_DEPTH = 8;
const MAX_ITEMS = 50;
/** The most keys an object keeps, in one example and over the whole run; then it is a map. */
const MAX_KEYS = 200;
/** This many keys of one shape (`user_1`, `user_2`) make an object a map whatever their number. */
const MANY_OF_ONE_SHAPE = 20;

function manyOfOneShape(keys: string[]): boolean {
  const seen = new Map<string, number>();
  for (const k of keys) {
    const shape = k.replace(/\d+/g, "0");
    const n = (seen.get(shape) ?? 0) + 1;
    if (n >= MANY_OF_ONE_SHAPE) return true;
    seen.set(shape, n);
  }
  return false;
}

/**
 * The JSON schema of one example value: types, object keys (all `required`) and array items — never the value. A
 * `null` gives `{ nullable: true }` with no type, so a later example can say what the type is. An empty array has no
 * `items` yet for the same reason. A key that is no {@link isName} is dropped alone. An object most of whose keys are
 * dropped, or with many keys of one shape or too many keys, is a map keyed by people or ids: its schema is
 * `additionalProperties` with the values' merged schema, and no key is kept.
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
      const keys = all.filter(isName);
      if (keys.length * 2 < all.length || all.length > MAX_KEYS || manyOfOneShape(keys)) {
        let values: JsonSchema | undefined;
        for (const k of all.slice(0, MAX_KEYS)) {
          const s = schemaOf((v as Record<string, unknown>)[k], depth + 1);
          values = values ? mergeSchema(values, s) : s;
        }
        return { type: "object", additionalProperties: values ?? {} };
      }
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
    const names = Object.keys(properties);
    if (names.length > MAX_KEYS || manyOfOneShape(names)) {
      const map: JsonSchema = { type: "object", additionalProperties: Object.values(properties).reduce((m, x) => mergeSchema(m, x)) };
      return nullable ? { ...map, nullable: true } : map;
    }
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
 * pinned to `null`), a name that is or holds a secret is dropped, and the top is marked derived. */
function finalSchema(s: JsonSchema, known: KnownValues, top = true): JsonSchema {
  let out: JsonSchema = { ...s };
  if (out.type === undefined) out = {};
  if (out.type === "array") out.items = out.items ? finalSchema(out.items as JsonSchema, known, false) : {};
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = finalSchema(out.additionalProperties as JsonSchema, known, false);
  }
  if (out.properties) {
    const entries = Object.entries(out.properties as Record<string, JsonSchema>);
    const kept = entries.filter(([k]) => !known.isSecret(k));
    if (kept.length * 2 < entries.length) {
      delete out.properties;
      delete out.required;
      out.additionalProperties = finalSchema(entries.map(([, v]) => v).reduce((m, x) => mergeSchema(m, x)), known, false);
    } else {
      out.properties = Object.fromEntries(kept.map(([k, v]) => [k, finalSchema(v, known, false)]));
      const required = ((out.required ?? []) as string[]).filter((k) => !known.isSecret(k));
      if (required.length) out.required = required;
      else delete out.required;
    }
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

const WRITTEN_MEDIA = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "text/csv",
  "text/xml",
  "application/xml",
  "application/octet-stream",
  "application/graphql",
]);

/** The media type to write for one that was seen: from a fixed set, `…+json` is `application/json`, anything else none. */
export function writtenMedia(contentType: string | undefined): string | undefined {
  const t = mediaType(contentType);
  if (isJsonMedia(t)) return "application/json";
  return t !== undefined && WRITTEN_MEDIA.has(t) ? t : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Known values

/** The longest value kept: a longer one cannot be a word of a path or a name. */
const MAX_KNOWN_LENGTH = 256;
/** The most values kept: about 120 MB of digests. Past it nothing can be checked, so no file is written. */
export const MAX_KNOWN_VALUES = 1_000_000;

export class TooManyValues extends Error {
  constructor(limit: number) {
    super(`too many distinct values to check the file against (more than ${limit})`);
  }
}

const digest = (normal: string): string => createHash("sha256").update(normal).digest("base64url").slice(0, 16);
const normal = (s: string): string => s.trim().toLowerCase();

/**
 * Every value the traffic showed, each as a fixed-size digest, so the memory goes with their number and not their size.
 * Filled during the run and read when the document is built, because a value can be seen after its path. A word of a path
 * equal to any of them is a value ({@link isValue}). A word and a name are checked against the run's secrets and the
 * traffic's credentials ({@link isSecret}), also by their parts; `?sort=name` must not take `name` out of every schema, and
 * `active` in an answer must not fold `/set-active`. A name that is a value anywhere else stays; the docs say so.
 */
export class KnownValues {
  private readonly values = new Set<string>();
  private readonly secrets = new Set<string>();
  /** The limit was hit: some value is not here, so nothing can be checked against this. */
  full = false;

  constructor(readonly limit = MAX_KNOWN_VALUES) {}

  get size(): number {
    return this.values.size;
  }

  private put(raw: string, secret: boolean): void {
    if (raw.length > MAX_KNOWN_LENGTH) return;
    const v = normal(raw);
    if (!v) return;
    if (v.includes("%")) this.put(decoded(v) === v ? "" : decoded(v), secret);
    const d = digest(v);
    if (this.values.has(d)) {
      if (secret) this.secrets.add(d);
      return;
    }
    if (this.values.size >= this.limit) {
      this.full = true;
      return;
    }
    this.values.add(d);
    if (secret) this.secrets.add(d);
  }

  add(value: string): void {
    this.put(value, false);
  }

  /** A credential or a secret of the run. One that is a word of the document's vocabulary is only a value. */
  secret(value: string): void {
    this.put(value, worthScrubbing(value));
  }

  /** One header's value, whole; with a credential header's parts (after `Bearer `, each cookie) as secrets. */
  header(name: string, value: string): void {
    for (const line of value.split("\n")) {
      this.add(line);
      // Of a Set-Cookie only the cookie: `Path=/` and `SameSite=Strict` are not its values.
      const v = /^set-cookie/i.test(name) ? (line.split(";")[0] ?? "") : line;
      if (DROPPED_HEADERS.test(name) || SENSITIVE.test(name)) for (const s of collectSecrets({ [name]: v })) this.secret(s);
    }
  }

  /** Every string in a parsed body, at any depth and past any item limit: a loop, so a deep body cannot overflow. */
  json(v: unknown): void {
    const stack: unknown[] = [v];
    while (stack.length > 0) {
      const x = stack.pop();
      if (typeof x === "string") this.add(x);
      else if (x && typeof x === "object") for (const y of Object.values(x)) stack.push(y);
    }
  }

  isValue(word: string): boolean {
    return this.values.has(digest(normal(word)));
  }

  /**
   * The word or name is a secret, or holds one as whole `-`/`_` separated parts: `reset-opensesame`, `reset-open-sesame-now`.
   * Never a piece of a part: a secret `admin` leaves `administrators` alone.
   */
  isSecret(word: string): boolean {
    const parts = normal(word).split(/([-_])/); // the separators stay, at the odd places: a secret may hold them too
    for (let from = 0; from < parts.length; from += 2) {
      let run = parts[from]!;
      if (this.secrets.has(digest(run))) return true;
      for (let to = from + 2; to < parts.length; to += 2) {
        run += parts[to - 1]! + parts[to]!;
        if (this.secrets.has(digest(run))) return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The document

interface Op {
  method: string;
  segs: Seg[];
  query: Set<string>;
  summary?: string;
  tags: Set<string>;
  seen: number;
  withBody: number;
  requestBodies: Map<string, JsonSchema | undefined>;
  responses: Map<string, Map<string, JsonSchema | undefined>>;
}

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
/** A longer path is no API's: it is dropped, so the folding below stays cheap whatever a page asks for. */
const MAX_SEGMENTS = 32;
/** This many distinct words in one place of a path, before the same ending, are values. */
const FOLD_AT = 3;

const merged = (prev: JsonSchema | undefined, next: JsonSchema | undefined, had: boolean): JsonSchema | undefined =>
  !had ? next : prev && next ? mergeSchema(prev, next) : (prev ?? next);

/**
 * Folds {@link Exchange}s into OpenAPI operations one at a time, so nothing but the merged shapes, the words that passed
 * their form and the digests of {@link known} is held. What depends on all the traffic is decided when the document is
 * built, because a value can be seen after its path.
 */
export class DerivedSpecBuilder {
  private readonly ops = new Map<string, Op>();
  readonly known: KnownValues;

  constructor(opts: { maxKnownValues?: number } = {}) {
    this.known = new KnownValues(opts.maxKnownValues);
  }

  /** How many operations the requests added so far make. */
  get size(): number {
    return this.resolved().length;
  }

  add(x: Exchange): void {
    this.known.json(x.request?.body);
    this.known.json(x.response?.body);
    const method = x.method.toLowerCase();
    if (!METHODS.has(method)) return;
    const segs = segmentsOf(x.path, x.authored === true);
    if (segs.length > MAX_SEGMENTS) return;
    const key = `${method} ${shapeOf(segs)}`;
    let op = this.ops.get(key);
    if (!op) {
      op = { method, segs, query: new Set(), tags: new Set(), seen: 0, withBody: 0, requestBodies: new Map(), responses: new Map() };
      this.ops.set(key, op);
    } else {
      // A path parameter is an integer only while every value seen was one.
      for (const [i, s] of segs.entries()) {
        const at = op.segs[i];
        if (at && !isLiteral(at) && !isLiteral(s) && !s.integer) at.integer = false;
      }
    }
    op.seen += 1;
    for (const q of x.queryKeys ?? []) if (isName(q)) op.query.add(q);
    if (op.summary === undefined && x.summary) op.summary = x.summary;
    for (const tag of x.tags ?? []) op.tags.add(tag);
    const declared = mediaType(x.request?.contentType);
    const reqType = writtenMedia(declared);
    if (x.request && (declared ? reqType : x.request.body !== undefined)) {
      op.withBody += 1;
      const mt = reqType ?? "application/json";
      const s = x.request.body !== undefined ? schemaOf(x.request.body) : undefined;
      op.requestBodies.set(mt, merged(op.requestBodies.get(mt), s, op.requestBodies.has(mt)));
    }
    if (x.status !== undefined && x.status >= 100 && x.status <= 599) {
      const status = String(x.status);
      const media = op.responses.get(status) ?? new Map<string, JsonSchema | undefined>();
      op.responses.set(status, media);
      const resType = writtenMedia(x.response?.contentType);
      const body = x.response?.body;
      if (resType && body !== undefined) media.set(resType, merged(media.get(resType), schemaOf(body), media.has(resType)));
    }
  }

  /**
   * The operations as the document has them. A word equal to a known value, or holding a secret as a part, is a parameter. Three or more distinct words
   * in one place of a path, with the same words before them and the same non-empty ending, are parameters too: no form
   * tells `alice` from `settings`, their number does. With nothing after them they stay: `/api/users` and `/api/settings`.
   */
  private resolved(): Op[] {
    const all = [...this.ops.values()].map((op) => ({
      op,
      segs: op.segs.map((s): Seg => (isLiteral(s) && s.literal !== "" && (this.known.isValue(s.literal) || this.known.isSecret(s.literal)) ? { integer: false } : s)),
    }));
    for (;;) {
      const places = new Map<string, Set<string>>();
      const placeOf = (segs: Seg[], i: number): string => `${i} ${shapeOf(segs.slice(0, i))} ${shapeOf(segs.slice(i + 1))}`;
      const each = (visit: (segs: Seg[], i: number, word: string) => void): void => {
        for (const { segs } of all) {
          for (let i = 0; i < segs.length - 1; i++) {
            const s = segs[i]!;
            if (isLiteral(s) && s.literal !== "") visit(segs, i, s.literal);
          }
        }
      };
      each((segs, i, word) => {
        const place = placeOf(segs, i);
        const words = places.get(place) ?? new Set<string>();
        words.add(word);
        places.set(place, words);
      });
      const folds: [Seg[], number][] = [];
      each((segs, i) => {
        if (places.get(placeOf(segs, i))!.size >= FOLD_AT) folds.push([segs, i]);
      });
      if (folds.length === 0) break;
      for (const [segs, i] of folds) segs[i] = { integer: false };
    }
    const out = new Map<string, Op>();
    for (const { op, segs } of all) {
      const key = `${op.method} ${shapeOf(segs)}`;
      const had = out.get(key);
      if (!had) {
        out.set(key, {
          ...op,
          segs,
          query: new Set(op.query),
          tags: new Set(op.tags),
          requestBodies: new Map(op.requestBodies),
          responses: new Map([...op.responses].map(([status, media]) => [status, new Map(media)])),
        });
        continue;
      }
      had.segs = had.segs.map((s, i) => {
        const other = segs[i]!;
        return isLiteral(s) || isLiteral(other) ? s : { ...s, integer: s.integer && other.integer };
      });
      for (const q of op.query) had.query.add(q);
      for (const t of op.tags) had.tags.add(t);
      had.summary ??= op.summary;
      had.seen += op.seen;
      had.withBody += op.withBody;
      for (const [mt, s] of op.requestBodies) had.requestBodies.set(mt, merged(had.requestBodies.get(mt), s, had.requestBodies.has(mt)));
      for (const [status, media] of op.responses) {
        const into = had.responses.get(status) ?? new Map<string, JsonSchema | undefined>();
        had.responses.set(status, into);
        for (const [mt, s] of media) into.set(mt, merged(into.get(mt), s, into.has(mt)));
      }
    }
    return [...out.values()];
  }

  /** The OpenAPI 3.0.3 document, paths and methods in a stable order. Throws {@link TooManyValues} past the limit: no document rather than an unchecked one. */
  toOpenApi(info: { title: string; version?: string; description?: string }, servers: string[] = []): Record<string, unknown> {
    if (this.known.full) throw new TooManyValues(this.known.limit);
    const paths: Record<string, Record<string, unknown>> = {};
    const ops = this.resolved()
      .map((op) => ({ op, ...written(op.segs) }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.op.method.localeCompare(b.op.method));
    for (const { op, path, params } of ops) {
      const item = (paths[path] ??= {});
      const parameters = [
        ...params.map((p) => ({ name: p.name, in: "path", required: true, schema: { type: p.integer ? "integer" : "string" } })),
        ...[...op.query]
          .filter((name) => !this.known.isSecret(name))
          .sort()
          .map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
      ];
      const responses: Record<string, unknown> = {};
      for (const [status, media] of [...op.responses].sort(([a], [b]) => a.localeCompare(b))) {
        const content = Object.fromEntries([...media].map(([mt, s]) => [mt, s ? { schema: finalSchema(s, this.known) } : {}]));
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
                content: Object.fromEntries([...op.requestBodies].map(([mt, s]) => [mt, s ? { schema: finalSchema(s, this.known) } : {}])),
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
 * Words a derived document is made of — JSON and OpenAPI vocabulary, flags, placeholders. A field whose value is one
 * of these (Swagger UI's `"password": "string"`, a cookie `csrftoken=true`) carries no secret.
 */
const VOCABULARY = new Set(
  [
    "true", "false", "null", "none", "undefined", "nil", "yes", "no", "on", "off",
    "string", "number", "integer", "boolean", "object", "array", "int", "float", "double", "date", "date-time",
    "text", "value", "example", "default", "empty", "secret", "token", "password", "bearer", "basic",
    "openapi", "info", "title", "version", "description", "servers", "server", "url", "paths", "path", "query",
    "header", "cookie", "parameters", "name", "in", "required", "schema", "schemas", "type", "properties", "items",
    "nullable", "content", "responses", "requestbody", "summary", "tags", "status", "recorded", "derived",
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
    "application/json", "text/plain", DERIVED_KEY,
  ].map((w) => w.toLowerCase()),
);
const MIN_SECRET = 4;

/** A value that counts as a secret: long enough, not a word the document is made of, not just the field's own name. */
function worthScrubbing(value: string, name?: string): boolean {
  const v = value.trim();
  if (v.length < MIN_SECRET) return false;
  const lower = v.toLowerCase();
  if (VOCABULARY.has(lower)) return false;
  if (name !== undefined && name.trim().toLowerCase().split(/\s+/).includes(lower)) return false;
  return true;
}

/**
 * The values a source carried that must not reach the file: every value of `Authorization`, `Cookie` and
 * `Set-Cookie` and of other sensitive headers (the credential after `Bearer `, each cookie value — the api guard's
 * {@link collectSecrets}), the values `decider/redact.ts` reads as secrets from `name: value` pairs (query, form and
 * body fields, variables: `password: …`, `api_key: …`), the user and password of a URL (`values`), and any value
 * shaped like a credential (a JWT, long hex). Placeholders and vocabulary (`"string"`, `true`, a value equal to its
 * field's name) are not secrets and are left out.
 */
export function exchangeSecrets(input: { headers?: [string, string][]; fields?: [string, string][]; values?: string[] }): string[] {
  const out = new Set<string>();
  const lines: string[] = [];
  const add = (v: string, name?: string): void => {
    if (worthScrubbing(v, name)) out.add(v.trim());
  };
  const shaped = (v: string): void => {
    for (const t of v.split(/[\s,;&=]+/)) if (t.length >= 8 && secretShaped(t)) add(t);
  };
  for (const [name, value] of input.headers ?? []) {
    if (DROPPED_HEADERS.test(name) || SENSITIVE.test(name)) for (const s of collectSecrets({ [name]: value })) add(s);
    else lines.push(`${name}: ${value}`);
    shaped(value);
  }
  for (const [name, value] of input.fields ?? []) {
    if (SENSITIVE.test(name)) add(value, name);
    lines.push(`${name}: ${value}`);
    shaped(value);
  }
  for (const v of input.values ?? []) add(v);
  for (const s of secretValues(lines.join("\n"), {})) add(s);
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
 * The one check left at the end, for free text a person wrote in a collection (its name, a request's name, a folder) and
 * a server's address: an element that holds a secret is dropped or, the title being required, replaced. The words and
 * names of the document were checked when it was built; no string in it is edited, so its structure stays as it is.
 */
function withoutSecretText(doc: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const holds = (t: unknown): boolean => typeof t === "string" && secrets.some((s) => t.includes(s));
  const out: Record<string, unknown> = { ...doc };
  const info = doc.info as { title?: unknown } | undefined;
  if (info && holds(info.title)) out.info = { ...info, title: "API draft" };
  if (Array.isArray(doc.servers)) {
    const servers = (doc.servers as { url?: unknown }[]).filter((s) => !holds(s.url));
    if (servers.length) out.servers = servers;
    else delete out.servers;
  }
  if (doc.paths && typeof doc.paths === "object") {
    out.paths = Object.fromEntries(
      Object.entries(doc.paths as Record<string, Record<string, Record<string, unknown>>>).map(([path, item]) => [
        path,
        Object.fromEntries(
          Object.entries(item).map(([method, op]) => {
            const { summary, tags, ...rest } = op;
            const kept = Array.isArray(tags) ? tags.filter((t) => !holds(t)) : [];
            return [method, { ...(summary !== undefined && !holds(summary) ? { summary } : {}), ...(kept.length ? { tags: kept } : {}), ...rest }];
          }),
        ),
      ]),
    );
  }
  return out;
}

/**
 * Save a derived spec as `openapi.derived.json` in `dir` and return its path. `secrets`: the ones that may be in a
 * collection's free text ({@link withoutSecretText}); give them to the document's {@link KnownValues} too, before it is built.
 */
export async function writeDerivedSpec(dir: string, doc: Record<string, unknown>, secrets: readonly string[] = []): Promise<string> {
  const all = [...new Set(secrets.map((s) => s.trim()))].filter((s) => worthScrubbing(s));
  const text = JSON.stringify(withoutSecretText(doc, all), null, 2);
  await mkdir(dir, { recursive: true });
  const file = join(dir, DERIVED_SPEC_FILE);
  await writeFile(file, `${text}\n`, "utf8");
  return file;
}
