/**
 * C1-04 / API-3 (#133) — execute the generated happy-path cases (API-2) against a configurable
 * base URL and assert each response.
 *
 * Per case we: build the request (path/query/header/cookie params + auth headers from config and
 * api-scope knowledge, #92), send it, assert the HTTP status matches the case's declared success
 * code, and assert the response body conforms to the declared success schema. Request/response
 * evidence is captured per case (with sensitive headers redacted) for the report slice (API-4).
 *
 * Transient transport faults (connection reset / timeout) and transient responses (429 / 5xx) reuse
 * the tiered-recovery pattern from BORROW-02 (#90) / `retryInvoke`: a positively-recognised transient
 * fault earns a cheap backoff + retry of the SAME request; everything else fails fast (we never mask a
 * real 4xx / assertion failure behind a retry). `fetch` is injected so tests never touch the network.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { ApiCase } from "./cases.js";

/** Minimal response shape we read — satisfied by the global `fetch` Response. */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

/** Auth/headers applied to every request (assembled from config + api-scope knowledge). */
export interface ApiAuth {
  headers: Record<string, string>;
}

export interface RunnerOptions {
  /** Configured base URL the relative case paths are resolved against. */
  baseUrl: string;
  auth?: ApiAuth;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Transient retries before giving up (default 2 — mirrors #90's nav ladder). */
  retries?: number;
  /** Backoff base (ms); delay = baseDelayMs * 2**attempt (default 300). */
  baseDelayMs?: number;
  /** Per-request timeout (ms); 0 disables it (default 30s). */
  timeoutMs?: number;
}

/** What we sent and got back for one case — the evidence the report (API-4) renders. */
export interface ApiCaseResult {
  name: string;
  method: string;
  url: string;
  request: { headers: Record<string, string>; body?: unknown };
  response?: { status: number; bodyText: string; json?: unknown };
  /** How many sends it took (1 = first try; >1 = a transient retry happened). */
  attempts: number;
  expectedStatus: string;
  /** status matched the declared success code. */
  statusOk: boolean;
  /** body conformed to the declared success schema (true when no schema is declared). */
  schemaOk: boolean;
  schemaErrors: string[];
  /** Transport error after retries were exhausted (no response received). */
  error?: string;
  /** statusOk && schemaOk && no transport error. */
  passed: boolean;
}

/** Header names whose values are secrets — masked in captured evidence so tokens never hit disk/logs. */
const SENSITIVE = /authorization|cookie|api[-_]?key|token|secret|password/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE.test(k) ? "***" : v;
  return out;
}

/**
 * Transient transport faults worth a backoff + retry. Mirrors #90's stance: only positively-recognised
 * transient errors retry; unknown faults and DNS/refused (a real misconfig) fail fast.
 */
const TRANSIENT_THROW = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network.?changed|the operation was aborted|aborted|timed? ?out/i;

/** A response status is transient (worth a retry) when it's a 429 or any 5xx. */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Execute every case against `baseUrl`, asserting status + schema; returns per-case evidence. */
export async function runApiCases(cases: ApiCase[], opts: RunnerOptions): Promise<ApiCaseResult[]> {
  const results: ApiCaseResult[] = [];
  for (const c of cases) results.push(await runOne(c, opts));
  return results;
}

async function runOne(c: ApiCase, opts: RunnerOptions): Promise<ApiCaseResult> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const url = buildUrl(opts.baseUrl, c);
  const headers = buildHeaders(c, opts.auth);
  const hasBody = c.body !== undefined;
  const isMultipart = c.bodyMediaType === "multipart/form-data";
  const init: RequestInit = {
    method: c.method,
    headers,
    ...(hasBody ? { body: isMultipart ? toFormData(c.body) : JSON.stringify(c.body) } : {}),
  };

  const evidence: ApiCaseResult = {
    name: c.name,
    method: c.method,
    url,
    request: { headers: redactHeaders(headers), ...(hasBody ? { body: c.body } : {}) },
    attempts: 0,
    expectedStatus: c.expectedStatus,
    statusOk: false,
    schemaOk: false,
    schemaErrors: [],
    passed: false,
  };

  // Tiered recovery ladder (#90): send → transient (throw or 429/5xx) with retries left → backoff + resend
  // the SAME request → else stop. A non-transient response (4xx, or a status mismatch) is a real result.
  let res: ResponseLike | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    evidence.attempts = attempt + 1;
    try {
      res = await withTimeout(doFetch, url, init, timeoutMs);
      if (isTransientStatus(res.status) && attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue; // transient response — retry the same request
      }
      break; // a result we can assert on
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === retries || !TRANSIENT_THROW.test(msg)) break; // exhausted or fatal → give up
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }

  if (!res) {
    evidence.error = lastErr instanceof Error ? lastErr.message : String(lastErr);
    return evidence; // no response → not passed
  }

  const bodyText = await res.text();
  const json = parseJson(bodyText);
  evidence.response = { status: res.status, bodyText, ...(json.ok ? { json: json.value } : {}) };

  evidence.statusOk = statusMatches(c.expectedStatus, res.status);

  if (c.expectedSchema === undefined) {
    evidence.schemaOk = true; // nothing declared to conform to
  } else if (!json.ok) {
    evidence.schemaOk = false;
    evidence.schemaErrors = [`response body is not valid JSON (${json.error})`];
  } else {
    evidence.schemaErrors = validateAgainstSchema(json.value, c.expectedSchema);
    evidence.schemaOk = evidence.schemaErrors.length === 0;
  }

  evidence.passed = evidence.statusOk && evidence.schemaOk;
  return evidence;
}

/**
 * A status matches when it equals the declared code. Two OpenAPI forms beyond an exact code:
 * `default` accepts any non-error (<400) status, and a range like `2XX` matches its whole class.
 */
function statusMatches(expected: string, actual: number): boolean {
  if (expected === "default") return actual < 400;
  if (/^\dXX$/i.test(expected)) return String(actual)[0] === expected[0];
  return String(actual) === expected;
}

async function withTimeout(doFetch: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<ResponseLike> {
  if (timeoutMs <= 0) return doFetch(url, init);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: undefined }; // empty body (e.g. 204) is valid
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Build the request URL: substitute `{path}` params, append `query` params, join onto the base URL. */
function buildUrl(baseUrl: string, c: ApiCase): string {
  let path = c.path;
  for (const [k, v] of Object.entries(c.params.path)) {
    path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(c.params.query)) qs.append(k, String(v));
  const query = qs.toString();
  const base = baseUrl.replace(/\/+$/, "");
  const sep = path.startsWith("/") ? "" : "/";
  return `${base}${sep}${path}${query ? `?${query}` : ""}`;
}

/**
 * Merge auth headers, case header-params and a Cookie header from cookie-params; add a JSON
 * content-type for a body case — UNLESS the operation declares `multipart/form-data` (API-10,
 * #150), where `fetch`/undici must generate its own `Content-Type: multipart/form-data; boundary=…`
 * from the `FormData` body; a manually-set header here would just fight (and lose to) that.
 */
function buildHeaders(c: ApiCase, auth?: ApiAuth): Record<string, string> {
  const headers: Record<string, string> = { ...(auth?.headers ?? {}) };
  for (const [k, v] of Object.entries(c.params.header)) headers[k] = String(v);
  const cookies = Object.entries(c.params.cookie);
  if (cookies.length) headers["Cookie"] = cookies.map(([k, v]) => `${k}=${v}`).join("; ");
  const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
  if (c.body !== undefined && !hasContentType && c.bodyMediaType !== "multipart/form-data") {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * C1-04 / API-10 (#150) — encode a synthesised body object as `multipart/form-data`. A `Buffer`
 * value (from `synth()`'s `format: binary` handling, `cases.ts`) becomes a file part; every other
 * value is a stringified form field. Relies on Node's native `FormData`/`File` (undici, global since
 * Node 18+) so `fetch` itself generates the boundary and per-part `Content-Disposition` — no
 * hand-rolled multipart encoder.
 */
function toFormData(body: unknown): FormData {
  const fd = new FormData();
  if (!body || typeof body !== "object") return fd;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined) continue;
    fd.append(k, Buffer.isBuffer(v) ? new File([v], `${k}.bin`, { type: "application/octet-stream" }) : String(v));
  }
  return fd;
}

/**
 * C1-04 / API-8 (#145) — strict JSON-Schema response conformance via `ajv` (draft 2020-12 + formats):
 * type/required/properties/items/enum/allOf/oneOf/anyOf, plus format/pattern/min/max/additionalProperties
 * that a hand-rolled checker would have to reimplement one keyword at a time. Returns path-qualified
 * error strings (same shape callers already expect).
 */
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
// ponytail: ajv-formats' .d.ts models CJS/ESM interop differently than its actual dist/index.js emit
// (`module.exports = formatsPlugin` directly) — the mismatch is type-only, so this cast matches runtime.
(addFormats as unknown as (a: Ajv) => void)(ajv);

/** One compiled validator per (already-dereferenced) schema object — a run checks the same declared
 * schema across many responses; recompiling per call would be wasted work. */
const compiledCache = new WeakMap<object, ValidateFunction>();

function compile(schema: object): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(deCycle(schema, new Set()) as object);
  compiledCache.set(schema, validate);
  return validate;
}

/**
 * Swagger-parser's `dereference()` (API-1) resolves circular `$ref`s into literal object-identity
 * cycles (e.g. `Pet.friends -> Pet`) rather than JSON-Schema `$ref` pointers — ajv can't compile a
 * schema containing a real object cycle (infinite recursion). Breaking the cycle at the point of
 * re-entry — tracked as the current DFS ancestor path, not a global "seen" set, since a schema
 * legitimately reused as two *sibling* branches is not a cycle — relaxes only the recursive tail to
 * "anything" and keeps the rest of the schema strict. Also folds OpenAPI 3.0's `nullable: true` into
 * a `type` array, since ajv only understands the keyword `type` (no 3.0 extensions).
 */
function deCycle(node: unknown, ancestors: Set<object>): unknown {
  if (!node || typeof node !== "object") return node;
  if (ancestors.has(node)) return true; // re-entering an ancestor — stop recursing, accept anything
  ancestors.add(node);
  try {
    if (Array.isArray(node)) return node.map((v) => deCycle(v, ancestors));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deCycle(v, ancestors);
    if (out.nullable === true) {
      const t = out.type;
      out.type = Array.isArray(t) ? [...t, "null"] : t !== undefined ? [t, "null"] : "null";
    }
    return out;
  } finally {
    ancestors.delete(node);
  }
}

export function validateAgainstSchema(value: unknown, schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const validate = compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => formatAjvError(e, path));
}

function formatAjvError(e: ErrorObject, root: string): string {
  const dotPath = e.instancePath ? e.instancePath.replace(/\//g, ".") : "";
  if (e.keyword === "required") {
    const prop = (e.params as { missingProperty: string }).missingProperty;
    return `${root}${dotPath}.${prop}: required property missing`;
  }
  if (e.keyword === "type") {
    return `${root}${dotPath}: expected ${(e.params as { type: string }).type}, got ${jsonType(e.data)}`;
  }
  if (e.keyword === "enum") {
    return `${root}${dotPath}: ${JSON.stringify(e.data)} not in enum`;
  }
  if (e.keyword === "additionalProperties") {
    const extra = (e.params as { additionalProperty: string }).additionalProperty;
    return `${root}${dotPath}: unexpected additional property "${extra}"`;
  }
  return `${root}${dotPath}: ${e.message ?? "invalid"}`;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  return typeof v; // string | boolean | object | undefined
}
