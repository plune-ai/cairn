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
  const init: RequestInit = {
    method: c.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(c.body) } : {}),
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

/** Merge auth headers, case header-params and a Cookie header from cookie-params; add JSON content-type. */
function buildHeaders(c: ApiCase, auth?: ApiAuth): Record<string, string> {
  const headers: Record<string, string> = { ...(auth?.headers ?? {}) };
  for (const [k, v] of Object.entries(c.params.header)) headers[k] = String(v);
  const cookies = Object.entries(c.params.cookie);
  if (cookies.length) headers["Cookie"] = cookies.map(([k, v]) => `${k}=${v}`).join("; ");
  if (c.body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Minimal JSON-Schema instance check for happy-path response conformance. The schema is already
 * dereferenced (API-1), so there are no `$ref`s to follow. Returns path-qualified error strings.
 *
 * ponytail: covers the keywords real success-response schemas use — type (incl. 3.1 type-arrays +
 * 3.0 `nullable`), required, properties, items, enum, and allOf/oneOf/anyOf composition. It does NOT
 * enforce format/pattern/min/max/additionalProperties — upgrade to ajv if strict contract checks are
 * ever needed (none of the happy-path slices require it).
 */
export function validateAgainstSchema(value: unknown, schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.allOf)) return s.allOf.flatMap((sub) => validateAgainstSchema(value, sub, path));
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.length) {
      const anyOk = branches.some((b) => validateAgainstSchema(value, b, path).length === 0);
      return anyOk ? [] : [`${path}: matches none of ${key}`];
    }
  }

  if (s.enum && Array.isArray(s.enum)) {
    return s.enum.some((e) => deepEqual(e, value)) ? [] : [`${path}: ${JSON.stringify(value)} not in enum`];
  }

  const types = normaliseTypes(s);
  if (types.length === 0) return []; // untyped schema — nothing to check
  if (value === null) return types.includes("null") ? [] : [`${path}: null is not ${types.join("|")}`];

  const actual = jsonType(value);
  if (!types.includes(actual)) return [`${path}: expected ${types.join("|")}, got ${actual}`];

  const errors: string[] = [];
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    for (const req of (s.required as string[]) ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required property missing`);
    }
    const props = (s.properties as Record<string, unknown>) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) errors.push(...validateAgainstSchema(obj[k], sub, `${path}.${k}`));
    }
  } else if (actual === "array" && s.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validateAgainstSchema(item, s.items, `${path}[${i}]`)));
  }
  return errors;
}

/** Declared types as a list, folding OpenAPI 3.0 `nullable: true` into an implicit `null` member. */
function normaliseTypes(s: Record<string, unknown>): string[] {
  const raw = s.type;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  if (s.nullable === true && !list.includes("null")) list.push("null");
  // `integer` is satisfied by a JSON number — collapse it so jsonType() comparison lines up.
  return list.map((t) => (t === "integer" ? "number" : t)) as string[];
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v as number) || typeof v === "number") return "number";
  return typeof v; // string | boolean | object | undefined
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
