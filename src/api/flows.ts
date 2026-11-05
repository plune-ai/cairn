/**
 * #230 — saved API flows: a named chain of requests (its steps, the values it returns, and the cleanup that deletes
 * what it created), kept in a JSON file and turned into a Playwright fixture for UI tests. A UI test then gets its
 * data or its session through the API instead of twenty UI steps, and the cleanup runs after the test whatever its
 * result (a fixture's teardown runs after a failed test, and the cleanup sits in a `finally`).
 *
 * A flow comes from a hand-written file or from `cairn api --scenarios --save-flows` (the create step of a scenario
 * chain, the id its delete needs, and the delete as cleanup). Nothing here sends a request: the fixture does, in the
 * user's own test run, and a flow that changes data refuses to run against an address no flag allowed — the same
 * read-only default as `cairn api --base-url` (#196).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { collectSecrets, READ_ONLY_METHODS, SENSITIVE } from "./guard.js";
import type { ApiCase } from "./cases.js";
import type { GeneratedSuite } from "../codegen/schema.js";
import type { ApiScenario } from "./scenarios.js";

/** The fixture module's file name, beside the specs that import it (`import { test, expect } from './api-flows.fixture'`). */
export const FLOW_FIXTURE_FILE = "api-flows.fixture.ts";

const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
/** `{{name}}`, `{{env.NAME}}` or `{{uid}}` inside any string of a step. */
const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Body / form / query keys (and header names) whose literal value would be a secret written into the file. */
const SECRET_KEY = /pass(?:w|phrase|code)|pwd|secret|token|credential|api[-_]?key|auth(?!or(?!i[sz]))/i;
/** Short words that name a secret only as a whole word of a key (`pass`, `userPass`, `db_pass`), not inside `compass`. */
const SECRET_WORDS = new Set(["pass", "passwd", "pw", "creds"]);
const isSecretKey = (key: string): boolean =>
  SECRET_KEY.test(key) || key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((w) => SECRET_WORDS.has(w.toLowerCase()));
/** A header whose name says it carries a credential (`Authorization`, `Cookie`, `X-Api-Key`, `X-Auth-Token`, …). */
export const isCredentialHeader = (name: string): boolean => SENSITIVE.test(name) || isSecretKey(name);
/** The only shape a secret may take in the file: `{{env.NAME}}`, after an optional `Bearer `/`Basic `/`Token ` scheme. */
const ENV_ONLY = /^(?:(?:Bearer|Basic|Token) )?\{\{\s*env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/i;
/** Names the Playwright test fixtures and options already use — a flow named so would shadow one. */
const PLAYWRIGHT_NAMES = new Set([
  "page", "context", "browser", "browserName", "request", "playwright", "baseURL", "storageState", "headless", "channel",
  "launchOptions", "connectOptions", "viewport", "video", "trace", "screenshot", "testIdAttribute", "extraHTTPHeaders",
  "httpCredentials", "ignoreHTTPSErrors", "locale", "timezoneId", "geolocation", "permissions", "offline", "colorScheme",
  "userAgent", "javaScriptEnabled", "bypassCSP", "proxy", "actionTimeout", "navigationTimeout", "contextOptions",
  "serviceWorkers", "acceptDownloads", "deviceScaleFactor", "hasTouch", "isMobile", "test", "expect", "use",
]);

/** A JSON pointer into the response body, written `/id` or as in OpenAPI links, `$response.body#/id`. */
const PointerSchema = z
  .string()
  .transform((s) => s.replace(/^\$response\.body#/, ""))
  .refine((s) => s.startsWith("/"), "a capture is a JSON pointer into the response body, e.g. /id or $response.body#/id");

const StepSchema = z
  .strictObject({
    name: z.string().optional(),
    method: z
      .string()
      .transform((s) => s.toUpperCase())
      .pipe(z.enum(METHODS)),
    path: z
      .string()
      .regex(/^\/(?!\/)/, "a path starts with a single '/' and is relative to the base URL")
      .refine((s) => !s.includes("?") && !s.includes("#"), "a path has no '?' or '#': query parameters go in \"query\""),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    form: z.record(z.string(), z.string()).optional(),
    /** Statuses that count as success; default any 2xx or 3xx (redirects are not followed). */
    expect: z.union([z.number().int(), z.array(z.number().int()).min(1)]).optional(),
    /** Values to keep from the JSON answer, by name, for later steps, the cleanup and `returns`. */
    capture: z.record(z.string().regex(IDENT, "a captured name is an identifier"), PointerSchema).optional(),
  })
  .refine((s) => s.body === undefined || s.form === undefined, "a step sends a JSON body or a form, not both");

const FlowSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "a flow name is a TypeScript identifier (it becomes the fixture's name)"),
  /** `data` (default): creates or reads data and returns values; `signin`: its cookies become the tests' storageState. */
  kind: z.enum(["data", "signin"]).default("data"),
  description: z.string().default(""),
  steps: z.array(StepSchema).min(1),
  returns: z.array(z.string()).default([]),
  cleanup: z.array(StepSchema).default([]),
});

const FlowFileSchema = z.strictObject({
  version: z.literal(1),
  /** Where the API lives; the fixture falls back to it when API_BASE_URL is not set. */
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  /** Headers on every request, e.g. `"Authorization": "Bearer {{env.API_TOKEN}}"`. */
  headers: z.record(z.string(), z.string()).optional(),
  flows: z.array(FlowSchema),
});

export type FlowStep = z.infer<typeof StepSchema>;
export type ApiFlow = z.infer<typeof FlowSchema>;
export type ApiFlowFile = z.infer<typeof FlowFileSchema>;

/**
 * A flow changes data when it is not a sign-in and any of its steps or cleanup steps is not GET/HEAD/OPTIONS. A
 * sign-in flow may send one such request — the login itself — and nothing else that changes data (checked on read).
 */
export function flowChangesData(flow: ApiFlow): boolean {
  return flow.kind === "data" && [...flow.steps, ...flow.cleanup].some((s) => !READ_ONLY_METHODS.has(s.method));
}

/** Every `{{…}}` name in a value (strings, arrays and objects, keys left alone). */
export function templateNames(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(TEMPLATE)].map((m) => m[1]!);
  if (Array.isArray(value)) return value.flatMap(templateNames);
  if (value && typeof value === "object") return Object.values(value).flatMap(templateNames);
  return [];
}

/**
 * #250: what a run's output must not repeat: the value of every `{{env.NAME}}` the file names, as written and as it goes
 * on the wire (encoded in a path, a query or a form, escaped in a JSON body). What is worth masking is decided as for a
 * credential header's value: too short or too common a value would mangle the text, and is left alone.
 */
export function flowEnvSecrets(file: ApiFlowFile, env: Record<string, string | undefined> = process.env): string[] {
  const values = templateNames(file).flatMap((n) => (n.startsWith("env.") ? (env[n.slice(4)] ?? []) : []));
  const forms = (s: string): string[] => [s, new URLSearchParams({ s }).toString().slice(2), JSON.stringify(s).slice(1, -1)];
  return [...new Set(values.flatMap((v) => collectSecrets({ Authorization: v }).flatMap(forms)))];
}

/** Body / form / query fields that hold a literal secret, as `key` paths. */
function literalSecrets(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => literalSecrets(v, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = at ? `${at}.${k}` : k;
    if (typeof v === "string" && isSecretKey(k) && v !== "" && !ENV_ONLY.test(v)) return [here];
    return literalSecrets(v, here);
  });
}

/** #233: the same rule for any header map Cairn reads from a file — a secret only as `{{env.NAME}}`. */
export function secretHeaderProblems(headers: Record<string, string> | undefined, where: string): string[] {
  const errors: string[] = [];
  checkHeaders(headers, where, errors);
  return errors;
}

function checkHeaders(headers: Record<string, string> | undefined, where: string, errors: string[]): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if ((SENSITIVE.test(name) || isSecretKey(name)) && !ENV_ONLY.test(value)) {
      errors.push(
        `${where}: header "${name}" holds a secret — write it as {{env.NAME}} (after an optional Bearer/Basic/Token) and set NAME in the environment`,
      );
    }
  }
}

/** A flow's exported type name: `project` → `ProjectFlow`. Two flows must not share one (`a` and `A`). */
const typeNameOf = (flow: string): string => `${flow.charAt(0).toUpperCase()}${flow.slice(1).replace(/^\$/, "")}Flow`;

/** The cross-field rules zod cannot express: names, templates, returns, cleanup and secrets. */
function checkFlowFile(file: ApiFlowFile): string[] {
  const errors: string[] = [];
  checkHeaders(file.headers, "headers", errors);
  for (const n of templateNames(file.headers)) {
    if (n !== "uid" && !/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(n)) errors.push(`headers: {{${n}}} — file headers may use only {{env.NAME}} and {{uid}}`);
  }
  const seen = new Set<string>();
  const typeNames = new Map<string, string>();
  for (const flow of file.flows) {
    const at = `flow "${flow.name}"`;
    if (seen.has(flow.name)) errors.push(`${at}: the name is used twice`);
    else {
      const other = typeNames.get(typeNameOf(flow.name));
      if (other !== undefined) errors.push(`${at}: its type ${typeNameOf(flow.name)} is also flow "${other}"'s — rename one of them`);
      else typeNames.set(typeNameOf(flow.name), flow.name);
    }
    seen.add(flow.name);
    if (PLAYWRIGHT_NAMES.has(flow.name)) errors.push(`${at}: "${flow.name}" is a Playwright fixture or option name — pick another`);

    const known = new Set(["uid"]);
    const checkStep = (step: FlowStep, where: string): void => {
      checkHeaders(step.headers, where, errors);
      for (const key of [...literalSecrets(step.body), ...literalSecrets(step.form), ...literalSecrets(step.query)]) {
        errors.push(`${where}: "${key}" holds a secret — write it as {{env.NAME}} and set NAME in the environment`);
      }
      for (const n of templateNames([step.path, step.headers, step.query, step.body, step.form])) {
        if (/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(n) || known.has(n)) continue;
        errors.push(`${where}: {{${n}}} names no value captured before it (nor env.NAME or uid)`);
      }
    };
    flow.steps.forEach((step, i) => {
      checkStep(step, `${at} step ${i + 1}`);
      for (const name of Object.keys(step.capture ?? {})) {
        if (name === "uid" || name === "env") errors.push(`${at} step ${i + 1}: "${name}" cannot be a captured name`);
        known.add(name);
      }
    });
    flow.cleanup.forEach((step, i) => {
      checkStep(step, `${at} cleanup ${i + 1}`);
      if (step.capture) errors.push(`${at} cleanup ${i + 1}: a cleanup step captures nothing`);
    });
    for (const r of flow.returns) {
      if (r === "uid" || !known.has(r)) errors.push(`${at}: "${flow.name}" returns "${r}", which no step captures`);
    }
    if (flow.kind === "signin") {
      if (flow.returns.length) errors.push(`${at}: a sign-in flow returns its session (storageState), not values`);
      if (flow.cleanup.length) errors.push(`${at}: a sign-in flow has no cleanup`);
      if (flow.steps.filter((s) => !READ_ONLY_METHODS.has(s.method)).length > 1) {
        errors.push(
          `${at}: a sign-in flow sends one request that changes data (the login) — its other steps are GET/HEAD/OPTIONS; put the rest in a data flow`,
        );
      }
    } else if (flowChangesData(flow) && flow.cleanup.length === 0) {
      errors.push(`${at}: "${flow.name}" changes data but has no cleanup — add the steps that delete what it creates`);
    }
  }
  if (file.flows.filter((f) => f.kind === "signin").length > 1) {
    errors.push("a file has at most one sign-in flow: it sets the tests' storageState, and there is only one");
  }
  return errors;
}

/** Read and check a flow file's text. Throws one error listing every problem found. */
export function parseApiFlows(text: string, source = "the API flow file"): ApiFlowFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser quotes the text around the error, and nothing has checked yet that this text holds no secret.
    throw new Error(`${source} is not valid JSON.`);
  }
  const parsed = FlowFileSchema.safeParse(raw);
  const problems = parsed.success
    ? checkFlowFile(parsed.data)
    : parsed.error.issues.map((i) => `${i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") || "(file)"}: ${i.message}`);
  if (problems.length || !parsed.success) {
    throw new Error(`${source} is not a valid API flow file:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return parsed.data;
}

/** Read a flow file from disk (see {@link parseApiFlows}). */
export async function loadApiFlows(path: string): Promise<ApiFlowFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read the API flow file ${path}: ${(e as Error).message}`);
  }
  return parseApiFlows(text, path);
}

// ── save a scenario chain as a flow ─────────────────────────────────────────

/** `pets lifecycle` → `pets`; `user-profiles` → `userProfiles`; a name Playwright uses gets a `Flow` suffix. */
function flowNameOf(scenario: ApiScenario): string {
  const words = scenario.name.replace(/\s+lifecycle$/, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let name = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("") || "flow";
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return PLAYWRIGHT_NAMES.has(name) ? `${name}Flow` : name;
}

const stringMap = (bucket: Record<string, unknown>): Record<string, string> | undefined => {
  const entries = Object.entries(bucket).map(([k, v]) => [k, String(v)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** A synthesised value under a secret-shaped key becomes `{{env.FLOW_KEY}}`: the file never holds a secret. */
function envForSecrets(value: unknown, flow: string): unknown {
  if (Array.isArray(value)) return value.map((v) => envForSecrets(v, flow));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      typeof v === "string" && isSecretKey(k) ? `{{env.${`${flow}_${k}`.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}}}` : envForSecrets(v, flow),
    ]),
  );
}

const statusOf = (c: ApiCase): number | undefined => (/^\d{3}$/.test(c.expectedStatus) ? Number(c.expectedStatus) : undefined);

/**
 * Turn generated scenario chains (API-9) into flows: the chain's create step, the values its DELETE needs (captured
 * from the create's answer — a declared `links` expression first, a same-name field second, as the scenario runner
 * does), and that DELETE as the cleanup. A chain without a DELETE is not saved: nothing would remove what it creates.
 */
export function flowsFromScenarios(scenarios: ApiScenario[]): { flows: ApiFlow[]; notSaved: { name: string; reason: string }[] } {
  const flows: ApiFlow[] = [];
  const notSaved: { name: string; reason: string }[] = [];
  for (const s of scenarios) {
    const create = s.steps[0];
    const del = s.steps.find((c) => c.method === "DELETE");
    if (!create || create.method !== "POST" || !del) {
      notSaved.push({ name: s.name, reason: "no DELETE step to clean up what it creates" });
      continue;
    }
    if (create.body !== undefined && JSON.stringify(create.body).includes('"type":"Buffer"')) {
      notSaved.push({ name: s.name, reason: "its create step sends a file (binary body), which a flow file cannot hold" });
      continue;
    }
    const name = flowNameOf(s);
    const needed = Object.keys(del.params.path);
    const capture: Record<string, string> = {};
    for (const param of needed) {
      const link = Object.values(create.responseLinks ?? {}).find((l) => l.operationId === del.operationId && l.parameters[param]);
      const expr = link?.parameters[param];
      capture[param] = expr && /^\$response\.body#\//.test(expr) ? expr.replace(/^\$response\.body#/, "") : `/${param}`;
    }
    // Path parameters of the create (a parent's id) keep their synthesised value; the delete's come from the capture.
    let createPath = create.path;
    for (const [k, v] of Object.entries(create.params.path)) createPath = createPath.replace(`{${k}}`, encodeURIComponent(String(v)));
    let deletePath = del.path;
    for (const param of needed) deletePath = deletePath.replace(`{${param}}`, `{{${param}}}`);
    const createStatus = statusOf(create);
    const deleteStatus = statusOf(del);
    const headers = stringMap(Object.fromEntries(Object.entries(create.params.header).filter(([k]) => !SENSITIVE.test(k) && !isSecretKey(k))));
    const asEnv = (q: Record<string, string> | undefined): Record<string, string> | undefined =>
      q && (envForSecrets(q, name) as Record<string, string>);
    const query = asEnv(stringMap(create.params.query));
    const delQuery = asEnv(stringMap(Object.fromEntries(Object.entries(del.params.query).filter(([k]) => !needed.includes(k)))));
    flows.push({
      name,
      kind: "data",
      description: `${s.name}: ${create.name} → ${del.name}, saved from cairn api --scenarios`,
      steps: [
        {
          name: create.name,
          method: "POST",
          path: createPath,
          ...(headers ? { headers } : {}),
          ...(query ? { query } : {}),
          ...(create.body !== undefined ? { body: envForSecrets(create.body, name) } : {}),
          ...(createStatus ? { expect: createStatus } : {}),
          capture,
        },
      ],
      returns: needed,
      cleanup: [
        {
          name: del.name,
          method: "DELETE",
          path: deletePath,
          ...(delQuery ? { query: delQuery } : {}),
          // 404: the test itself already removed it — nothing is left behind either way.
          ...(deleteStatus ? { expect: [deleteStatus, 404] } : {}),
        },
      ],
    });
  }
  return { flows, notSaved };
}

/** Put `flows` into `file`: a flow with the same name is replaced in place, a new one is appended, the rest kept. */
export function mergeApiFlows(file: ApiFlowFile, flows: ApiFlow[]): ApiFlowFile {
  const byName = new Map(flows.map((f) => [f.name, f]));
  const merged = file.flows.map((f) => byName.get(f.name) ?? f);
  for (const f of flows) if (!file.flows.some((e) => e.name === f.name)) merged.push(f);
  return { ...file, flows: merged };
}

// ── the Playwright fixture ──────────────────────────────────────────────────


/**
 * The fixture module's runtime: the generic step runner the per-flow fixtures call. Kept as plain text so the
 * written file needs nothing but `@playwright/test`.
 */
const RUNTIME = String.raw`type Step = {
  name?: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  expect?: number | number[];
  capture?: Record<string, string>;
};
type Flow = { name: string; kind: 'data' | 'signin'; description?: string; changesData: boolean; steps: Step[]; returns: string[]; cleanup: Step[] };
type Vars = Record<string, string>;
type Playwright = PlaywrightWorkerArgs['playwright'];
type StorageState = PlaywrightTestOptions['storageState'];

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;
const READ_ONLY = ['GET', 'HEAD', 'OPTIONS'];

/** A value that cannot stand as one path segment: empty, '.' or '..', or one holding a '/'. */
const badSegment = (v: string): boolean => v === '' || v === '.' || v === '..' || v.includes('/');

/** Where the API lives: API_BASE_URL, then the flow file / the flag, then use.baseURL of the Playwright config. */
function apiBaseUrl(baseURL: string | undefined): string {
  const url = process.env.API_BASE_URL || DEFAULT_BASE_URL || baseURL;
  if (!url) throw new Error('API flows need a base URL: set API_BASE_URL, baseUrl in the flow file, or use.baseURL in the Playwright config');
  return url.replace(/\/+$/, '');
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** A flow that changes data runs only against an origin the flag allowed, or one listed in CAIRN_ALLOW_MUTATIONS. */
function mutationsAllowed(url: string): boolean {
  const origin = originOf(url);
  const fromEnv = (process.env.CAIRN_ALLOW_MUTATIONS ?? '').split(',').map((s) => originOf(s.trim()));
  return origin !== undefined && (MUTATIONS_ALLOWED_FOR.includes(origin) || fromEnv.includes(origin));
}

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function fill(value: unknown, vars: Vars, encode = false): unknown {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE, (_m, key: string) => {
      const v = key.startsWith('env.') ? process.env[key.slice(4)] : vars[key];
      if (v === undefined) {
        throw new Error(key.startsWith('env.') ? 'API flow: the environment variable ' + key.slice(4) + ' is not set' : 'API flow: no value for {{' + key + '}}');
      }
      // In a path a value is one segment: never an empty one, never '.' or '..', never two. The value may be a secret,
      // or anything the server answered: name it, never print it.
      if (encode && badSegment(v)) throw new Error('API flow: {{' + key + '}} is a value, which cannot stand in the path ' + value);
      return encode ? encodeURIComponent(v) : v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars, encode));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars, encode)]));
  return value;
}

/**
 * Whether every value a step names was captured (and those in its path can stand as a path segment) — a cleanup step
 * for something never created, or never named, is left out.
 */
const canFill = (step: Step, vars: Vars): boolean =>
  [...JSON.stringify(step).matchAll(TEMPLATE)].every((m) => m[1]!.startsWith('env.') || m[1]! in vars) &&
  [...step.path.matchAll(TEMPLATE)].every((m) => m[1]!.startsWith('env.') || !badSegment(vars[m[1]!]!));

function at(body: unknown, pointer: string): unknown {
  let cur: unknown = body;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const pick = (vars: Vars, names: string[]): Vars => Object.fromEntries(names.map((n) => [n, vars[n]!]));

/**
 * Why a request got no answer: a fixed word, or a system code read from the first line of Playwright's error. Its text
 * is never repeated: the call log in it holds the full URL and every header, with the values read from the environment.
 */
function whyNoAnswer(e: unknown): string {
  const first = String((e as Error | null)?.message).split('\n')[0]!;
  if (/\bTimeout \d+ms exceeded/.test(first)) return 'timeout';
  return /\bE[A-Z0-9_]{2,40}\b/.exec(first)?.[0] ?? 'network error';
}

async function runStep(ctx: APIRequestContext, base: string, flow: string, step: Step, vars: Vars): Promise<void> {
  const label = 'API flow "' + flow + '" step "' + (step.name ?? step.method + ' ' + step.path) + '"';
  const options: NonNullable<Parameters<APIRequestContext['fetch']>[1]> = {
    method: step.method,
    headers: fill({ ...HEADERS, ...step.headers }, vars) as Record<string, string>,
    maxRedirects: 0,
  };
  if (step.query) options.params = fill(step.query, vars) as Record<string, string>;
  if (step.body !== undefined) options.data = fill(step.body, vars);
  if (step.form) options.form = fill(step.form, vars) as Record<string, string>;
  const res = await ctx.fetch(base + (fill(step.path, vars, true) as string), options).catch((e: unknown): never => {
    throw new Error(label + ' got no answer: ' + whyNoAnswer(e));
  });
  const want = step.expect === undefined ? undefined : ([] as number[]).concat(step.expect);
  const ok = want ? want.includes(res.status()) : res.status() >= 200 && res.status() < 400;
  if (!ok) throw new Error(label + ' answered ' + res.status() + ' (want ' + (want ? want.join(' or ') : '2xx or 3xx') + ')');
  if (!step.capture) return;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(label + ': the answer is not JSON, so nothing can be captured from it');
  }
  // An empty value counts as not captured: nothing can be found or deleted by it.
  const missing: string[] = [];
  for (const [name, pointer] of Object.entries(step.capture)) {
    const v = at(body, pointer);
    if (v === undefined || v === null || typeof v === 'object' || String(v) === '') missing.push(pointer + ' for ' + name);
    else vars[name] = String(v);
  }
  if (missing.length) throw new Error(label + ': the answer has no value at ' + missing.join(', '));
}

/** Run a data flow, hand its values to the test, and clean up afterwards — after a failed test too. */
async function dataFlow(
  flow: Flow,
  playwright: Playwright,
  baseURL: string | undefined,
  storageState: StorageState,
  use: (value: Vars) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const base = apiBaseUrl(baseURL);
  if (flow.changesData && !mutationsAllowed(base)) {
    const origin = originOf(base) ?? base;
    testInfo.skip(true, 'API flow "' + flow.name + '" changes data, and ' + origin + ' is not allowed: write the fixture with --allow-mutations for it, or set CAIRN_ALLOW_MUTATIONS=' + origin);
    return;
  }
  const ctx = await playwright.request.newContext(storageState ? { storageState } : {});
  const vars: Vars = { uid: uid() };
  try {
    for (const step of flow.steps) await runStep(ctx, base, flow.name, step, vars);
    await use(pick(vars, flow.returns));
  } finally {
    const errors: string[] = [];
    for (const step of flow.cleanup) {
      if (!canFill(step, vars)) continue;
      try {
        await runStep(ctx, base, flow.name, step, vars);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    await ctx.dispose();
    if (errors.length) throw new Error('API flow "' + flow.name + '": the cleanup failed, the data may still be there\n' + errors.join('\n'));
  }
}

/** Run a sign-in flow in a fresh request context and return its cookies as a storageState. */
async function signIn(flow: Flow, playwright: Playwright, baseURL: string | undefined): Promise<StorageState> {
  const base = apiBaseUrl(baseURL);
  // The login is the one request a sign-in flow may send that changes data; a flow file is checked for this on read.
  if (flow.steps.filter((s) => !READ_ONLY.includes(s.method)).length > 1) {
    throw new Error('API flow "' + flow.name + '": a sign-in flow sends one request that changes data (the login); nothing was sent');
  }
  const ctx = await playwright.request.newContext();
  try {
    const vars: Vars = { uid: uid() };
    for (const step of flow.steps) await runStep(ctx, base, flow.name, step, vars);
    return await ctx.storageState();
  } finally {
    await ctx.dispose();
  }
}`;

export interface FixtureOptions {
  /** The API's base URL written into the fixture (wins over the file's `baseUrl`); API_BASE_URL still overrides it. */
  baseUrl?: string;
  /** The address `--allow-mutations` was given for: only its origin may be changed by a data flow. */
  allowMutationsFor?: string;
  /** Shown in the header comment: where the flows were read from. */
  source?: string;
}

/**
 * The Playwright fixture module for a flow file: one test-scoped fixture per data flow (its value is the flow's
 * `returns`), and the sign-in flow, if any, as an override of `storageState`. Values written as `{{env.NAME}}` are
 * read when a test runs; none is written into the module.
 */
export function renderFlowFixture(file: ApiFlowFile, opts: FixtureOptions): string {
  const baseUrl = opts.baseUrl ?? file.baseUrl;
  const allowed = opts.allowMutationsFor ? [new URL(opts.allowMutationsFor).origin] : [];
  const flows = Object.fromEntries(file.flows.map((f) => [f.name, { ...f, changesData: flowChangesData(f) }]));
  const data = file.flows.filter((f) => f.kind === "data");
  const signin = file.flows.find((f) => f.kind === "signin");

  const L: string[] = [
    `// Playwright fixtures for the API flows${opts.source ? ` in ${opts.source.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")}` : ""} (cairn, #230). Written by \`cairn api --flows\`;`,
    "// edit the flow file and write this module again rather than editing it by hand.",
    "// {{env.NAME}} values are read from the environment when a test runs; none is stored here.",
    "import {",
    "  test as base,",
    "  expect,",
    "  type APIRequestContext,",
    "  type PlaywrightTestOptions,",
    "  type PlaywrightWorkerArgs,",
    "  type TestInfo,",
    "} from '@playwright/test';",
    "",
    `const HEADERS: Record<string, string> = ${JSON.stringify(file.headers ?? {})};`,
    `const FLOWS: Record<string, Flow> = ${JSON.stringify(flows, null, 2)};`,
    `const DEFAULT_BASE_URL: string | undefined = ${baseUrl ? JSON.stringify(baseUrl) : "undefined"};`,
    `const MUTATIONS_ALLOWED_FOR: string[] = ${JSON.stringify(allowed)};`,
    "",
    RUNTIME,
    "",
  ];
  for (const f of data) {
    const fields = f.returns.map((r) => `${r}: string`).join("; ");
    L.push(`export type ${typeNameOf(f.name)} = ${fields ? `{ ${fields} }` : "Record<string, never>"};`);
  }
  if (data.length) L.push("");
  const shape = data.map((f) => `${f.name}: ${typeNameOf(f.name)}`).join("; ");
  L.push(`export const test = base.extend<{ ${shape} }>({`);
  for (const f of data) {
    L.push(`  ${f.name}: async ({ playwright, baseURL, storageState }, use, testInfo) => {`);
    L.push(`    await dataFlow(FLOWS[${JSON.stringify(f.name)}]!, playwright, baseURL, storageState, (v) => use(v as ${typeNameOf(f.name)}), testInfo);`);
    L.push("  },");
  }
  if (signin) {
    L.push("  storageState: async ({ playwright, baseURL }, use) => {");
    L.push(`    await use(await signIn(FLOWS[${JSON.stringify(signin.name)}]!, playwright, baseURL));`);
    L.push("  },");
  }
  L.push("});", "", "export { expect };", "");
  return L.join("\n");
}

/** The suite with Cairn's fixture module in it, in place of any file of that name the model wrote. */
export function withFlowFixture(suite: GeneratedSuite, fixture: string): GeneratedSuite {
  return { files: [...suite.files.filter((f) => f.path !== FLOW_FIXTURE_FILE), { path: FLOW_FIXTURE_FILE, content: fixture }] };
}

// ── what design and automate are told ───────────────────────────────────────

/** One line per flow: its name, what it does and returns, and its description — for the design and codegen prompts. */
export function formatFlowsForPrompt(file: ApiFlowFile): string {
  return file.flows
    .map((f) => {
      const desc = f.description ? ` — ${f.description}` : "";
      if (f.kind === "signin") return `- ${f.name} (signs in through the API; the test starts with its session as storageState)${desc}`;
      const returns = f.returns.length ? `returns ${f.returns.join(", ")}` : "returns nothing";
      const what = flowChangesData(f) ? `creates data; ${returns}; its cleanup deletes it afterwards` : `reads data; ${returns}`;
      return `- ${f.name} (${what})${desc}`;
    })
    .join("\n");
}
