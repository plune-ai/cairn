/**
 * #233 — the two-actor check of the `hacker` style: IDOR and privilege escalation. The single-request `hacker` case
 * (`adversarial.ts`) only strips auth; these cases need state and two identities, so they run as their own check.
 *
 * Actor A (the owner) creates a resource through a saved API flow (#230). Actor B (the other user, or a lower role)
 * then tries to read, change and delete it, and reads the ids next to it. A 2xx to B is a finding, tagged with its
 * OWASP WSTG id: WSTG-ATHZ-04 (IDOR) when B is another user of the same role, WSTG-ATHZ-03 (privilege escalation) when
 * B is a lower role. Neighbouring ids are always WSTG-ATHZ-04, and count only when BOTH actors can read the same id:
 * an id one of them owns answers the other with a refusal on a fixed server, so a neighbour both read is private to
 * neither.
 *
 * Every request goes through the run's {@link RequestGuard} (`--allow-mutations`, `--allowed-methods`,
 * `--allowed-paths`, `--max-requests`, `--rps`): there is no second safety mechanism. The check creates data, so it
 * sends nothing without `--allow-mutations`, and a check whose flow or cleanup a flag forbids is not started at all —
 * Cairn never creates what it may not delete. The flow's own cleanup runs in a `finally`, after a failure too.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { SessionStore } from "../session/index.js";
import type { StorageState } from "../browser/types.js";
import { loadApiFlows, secretHeaderProblems, type ApiFlow, type ApiFlowFile, type FlowStep } from "./flows.js";
import type { RequestGuard } from "./guard.js";

export type TwoActorProbe = "read" | "change" | "delete" | "neighbours";
const PROBES = ["read", "change", "delete", "neighbours"] as const;

export const WSTG_IDOR = "WSTG-ATHZ-04";
export const WSTG_PRIVILEGE_ESCALATION = "WSTG-ATHZ-03";

const ActorSchema = z
  .strictObject({
    /** A saved session's name, as everywhere in Cairn: `.auth/<name>.storageState.json` (`cairn session capture --name`). */
    session: z.string().regex(/^[\w.-]+$/, "a session name, as given to cairn session capture --name").optional(),
    /** Headers for this actor, e.g. `"Authorization": "Bearer {{env.BOB_TOKEN}}"`; a secret only as {{env.NAME}}. */
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((a) => a.session !== undefined || a.headers !== undefined, "an actor needs a session or headers");

const CheckSchema = z.strictObject({
  /** The data flow actor A runs to create the resource; its cleanup deletes it. */
  flow: z.string(),
  /** The resource's path, with the flow's captured values: `/api/projects/{{projectId}}`. */
  resource: z
    .string()
    .regex(/^\/(?!\/)/, "a path starts with a single '/' and is relative to the base URL")
    .refine((s) => /\{\{\s*\w+\s*\}\}/.test(s), "the resource path names the created id, e.g. /api/projects/{{projectId}}")
    .refine((s) => !s.includes("?") && !s.includes("#"), "a resource path has no '?' or '#'"),
  /** How actor B tries to change it (default PATCH with an empty JSON object). */
  change: z
    .strictObject({
      method: z
        .string()
        .transform((s) => s.toUpperCase())
        .pipe(z.enum(["PATCH", "PUT", "POST"])),
      body: z.unknown().optional(),
    })
    .default({ method: "PATCH", body: {} }),
  /** How many ids on each side of a numeric id actor B reads (0 = none). */
  neighbours: z.number().int().min(0).max(10).default(2),
  /** Which probes run (default all four). */
  probes: z.array(z.enum(PROBES)).min(1).default([...PROBES]),
});

const TwoActorFileSchema = z.strictObject({
  version: z.literal(1),
  /** The API flow file (#230), relative to this file. */
  flows: z.string().min(1),
  /** Where the named sessions are, relative to this file (default `.auth` in the working directory, as elsewhere). */
  sessionsDir: z.string().min(1).optional(),
  actors: z.strictObject({
    /** Actor A: creates the resource. */
    owner: ActorSchema,
    /** Actor B: another user of the same role (`peer`, default) or a lower role (`lower`). */
    other: z.intersection(ActorSchema, z.object({ role: z.enum(["peer", "lower"]).default("peer") })),
  }),
  checks: z.array(CheckSchema).min(1),
});

export type TwoActorFile = z.infer<typeof TwoActorFileSchema>;
export type TwoActorCheck = z.infer<typeof CheckSchema>;
export type ActorConfig = z.infer<typeof ActorSchema>;

/** A checked two-actor file with its flow file read. */
export interface TwoActorPlan {
  file: TwoActorFile;
  flows: ApiFlowFile;
  /** Absolute sessions directory. */
  sessionsDir: string;
}

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Read and check a two-actor file's text against its (already read) flow file. Throws one error listing every problem. */
export function parseTwoActorFile(text: string, flows: ApiFlowFile, source = "the two-actor file"): TwoActorFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = TwoActorFileSchema.safeParse(raw);
  const problems = parsed.success
    ? checkAgainstFlows(parsed.data, flows)
    : parsed.error.issues.map((i) => `${i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") || "(file)"}: ${i.message}`);
  if (problems.length || !parsed.success) {
    throw new Error(`${source} is not a valid two-actor file:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return parsed.data;
}

function checkAgainstFlows(file: TwoActorFile, flows: ApiFlowFile): string[] {
  const errors = [
    ...secretHeaderProblems(file.actors.owner.headers, "actors.owner"),
    ...secretHeaderProblems(file.actors.other.headers, "actors.other"),
  ];
  file.checks.forEach((check, i) => {
    const at = `checks[${i}]`;
    const flow = flows.flows.find((f) => f.name === check.flow);
    if (!flow) return errors.push(`${at}: no flow "${check.flow}" in the flow file`);
    if (flow.kind !== "data") return errors.push(`${at}: "${check.flow}" is a sign-in flow; the owner creates the resource with a data flow`);
    if (flow.cleanup.length === 0) errors.push(`${at}: "${check.flow}" has no cleanup — the check never creates what it cannot delete`);
    const captured = new Set(flow.steps.flatMap((s) => Object.keys(s.capture ?? {})));
    for (const m of [...check.resource.matchAll(TEMPLATE), ...JSON.stringify(check.change.body ?? null).matchAll(TEMPLATE)]) {
      const name = m[1]!;
      if (name === "uid" || name.startsWith("env.") || captured.has(name)) continue;
      errors.push(`${at}: {{${name}}} is not captured by flow "${check.flow}"`);
    }
    return undefined;
  });
  return errors;
}

/** Read a two-actor file and the flow file it names (relative to it). */
export async function loadTwoActorPlan(path: string): Promise<TwoActorPlan> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read the two-actor file ${path}: ${(e as Error).message}`);
  }
  let flowsPath: string;
  try {
    flowsPath = resolve(dirname(path), z.object({ flows: z.string() }).parse(JSON.parse(text)).flows);
  } catch {
    // Let the full parse say what is wrong.
    parseTwoActorFile(text, { version: 1, flows: [] }, path);
    throw new Error(`${path} is not a valid two-actor file`);
  }
  const flows = await loadApiFlows(flowsPath);
  const file = parseTwoActorFile(text, flows, path);
  const sessionsDir = file.sessionsDir ? resolve(dirname(path), file.sessionsDir) : resolve(".auth");
  return { file, flows, sessionsDir };
}

// ── actors ──────────────────────────────────────────────────────────────────

/** The cookies of a storageState that a request to `baseUrl` would carry, as one `Cookie` header value. */
export function cookieHeaderFor(state: StorageState, baseUrl: string, now = Date.now() / 1000): string | undefined {
  const url = new URL(baseUrl);
  const pairs = state.cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./, "").toLowerCase();
      const host = url.hostname.toLowerCase();
      const domainOk = host === domain || host.endsWith(`.${domain}`);
      const pathOk = (url.pathname || "/").startsWith(c.path || "/") || c.path === "/";
      const alive = c.expires === undefined || c.expires === -1 || c.expires > now;
      const secureOk = c.secure !== true || url.protocol === "https:";
      return domainOk && pathOk && alive && secureOk;
    })
    .map((c) => `${c.name}=${c.value}`);
  return pairs.length ? pairs.join("; ") : undefined;
}

/**
 * Merge header maps left to right with names compared case-insensitively: a later `authorization` replaces an earlier
 * `Authorization`, so one name never goes out with two values (fetch would join them with a comma).
 */
export function mergeHeaders(...maps: (Record<string, string> | undefined)[]): Record<string, string> {
  const out = new Map<string, [string, string]>();
  for (const map of maps) for (const [name, value] of Object.entries(map ?? {})) out.set(name.toLowerCase(), [name, value]);
  return Object.fromEntries(out.values());
}

/**
 * The only flow-file headers the other actor takes: they describe the request's format, never who sends it. Any other
 * name — `Authorization`, but also `X-Session-Id`, `X-User-Id`, `X-Tenant`, `DPoP`, a name nobody can list in advance —
 * may carry the owner's identity, so it stays with the owner.
 */
const FORMAT_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

/**
 * One actor's request headers: the flow file's, then the actor's own, then the saved session's cookies (which replace
 * any `Cookie` the actor wrote). The flow file's headers belong to the owner (its token, as the flow docs show), so
 * only the owner — `plan.file.actors.owner` itself — gets them whole. Every other actor takes from them only Accept,
 * Accept-Language, Content-Type and User-Agent, and none filled from the environment: everything else it sends comes
 * from its own actor definition. The other actor carries no identity but its own, by construction.
 */
export async function actorHeaders(
  actor: ActorConfig,
  plan: TwoActorPlan,
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const isOwner = actor === plan.file.actors.owner;
  const shared = Object.fromEntries(
    Object.entries(plan.flows.headers ?? {}).filter(([name, value]) => isOwner || (FORMAT_HEADERS.has(name.toLowerCase()) && !/\{\{\s*env\./.test(value))),
  );
  const headers = fillHeaders(mergeHeaders(shared, actor.headers), env);
  if (actor.session) {
    const state = await new SessionStore(plan.sessionsDir).load(actor.session);
    const cookie = cookieHeaderFor(state, baseUrl);
    if (!cookie) throw new Error(`The saved session "${actor.session}" has no cookie for ${new URL(baseUrl).origin}.`);
    return mergeHeaders(headers, { Cookie: cookie });
  }
  return headers;
}

function fillHeaders(headers: Record<string, string>, env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      const filled = v.replace(TEMPLATE, (_m, key: string) => {
        if (!key.startsWith("env.")) throw new Error(`Header "${k}": only {{env.NAME}} may be used in an actor's headers`);
        const value = env[key.slice(4)];
        if (value === undefined || value === "") throw new Error(`Header "${k}": the environment variable ${key.slice(4)} is not set`);
        return value;
      });
      const refusal = headerRefusal(k, v, filled);
      if (refusal) throw new Error(`${refusal}; nothing was sent`);
      return [k, filled];
    }),
  );
}

/**
 * Whether a header can be sent at all, as one line that names the header and the `{{env.NAME}}` it was built from and
 * never its value: fetch quotes a bad value in its own error text, and the value may be a secret.
 */
function headerRefusal(name: string, template: string | undefined, value: string): string | undefined {
  const category = !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ? "invalid header name" : /[\0\r\n]|[^\x00-\xff]/.test(value) ? "invalid header value" : undefined;
  if (!category) return undefined;
  const from = [...(template ?? "").matchAll(TEMPLATE)].map((m) => `{{${m[1]}}}`);
  return `header "${name}" is not valid (${category}${from.length ? `, built from ${from.join(", ")}` : ""})`;
}

// ── running ─────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TwoActorOptions {
  baseUrl: string;
  guard: RequestGuard;
  owner: Record<string, string>;
  other: Record<string, string>;
  /** Actor B's relation to A: another user (`peer`) or a lower role (`lower`). */
  role: "peer" | "lower";
  fetch?: FetchLike;
  /** Per-request timeout (ms), default 30s. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export type CaseOutcome = "finding" | "denied" | "inconclusive" | "skipped";

export interface TwoActorCaseResult {
  check: string;
  probe: TwoActorProbe;
  wstgId: string;
  method: string;
  path: string;
  outcome: CaseOutcome;
  /** Actor B's status (and, for a neighbour B could read, the owner's). */
  status?: number;
  ownerStatus?: number;
  detail: string;
}

export interface TwoActorCheckResult {
  check: string;
  flow: string;
  /** Not started (a flag forbids its flow, its cleanup or mutations, or the budget cannot cover it). */
  notRun?: string;
  /** The check stopped midway (the flow failed, a request failed); the cleanup still ran. */
  error?: string;
  /** The cleanup's own failures: the created data may still be there. */
  cleanupErrors: string[];
  cases: TwoActorCaseResult[];
}

export interface TwoActorReport {
  baseUrl: string;
  role: "peer" | "lower";
  checks: TwoActorCheckResult[];
  findings: number;
}

class RequestFailed extends Error {}

/**
 * Why a request failed, as a fixed category taken from the error's name or code, never from its message: fetch quotes
 * the URL and the header value it was given, and either may hold a secret from the environment.
 */
const failureCategory = (e: unknown): string => {
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? `network: ${code}` : "network error";
};

/** What a caught error may add to the report: our own messages (built from safe parts), never an unknown error's text. */
const reportable = (e: unknown): string => (e instanceof RequestFailed ? e.message : `unexpected failure (${failureCategory(e)})`);

const fillValue = (value: unknown, vars: Record<string, string>, env: Record<string, string | undefined>, encode = false): unknown => {
  if (typeof value === "string") {
    return value.replace(TEMPLATE, (_m, key: string) => {
      const v = key.startsWith("env.") ? env[key.slice(4)] : vars[key];
      if (v === undefined) throw new RequestFailed(key.startsWith("env.") ? `the environment variable ${key.slice(4)} is not set` : `no value for {{${key}}}`);
      if (encode && (v === "" || v === "." || v === ".." || v.includes("/"))) {
        // An environment value may be a secret: name it, never print it.
        throw new RequestFailed(`{{${key}}} is ${key.startsWith("env.") ? "a value" : JSON.stringify(v)}, which cannot stand in the path ${value}`);
      }
      return encode ? encodeURIComponent(v) : v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillValue(v, vars, env, encode));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillValue(v, vars, env, encode)]));
  return value;
};

/**
 * A path as error text and the report show it: the captured values filled in (`/api/projects/3`), every
 * `{{env.NAME}}` left as the flow file wrote it — an environment value may be a secret (`?token={{env.API_TOKEN}}`),
 * and the report and the terminal must never hold it. The query, if any, is written out unencoded, the same way.
 */
export const shownPath = (path: string, vars: Record<string, string>, query?: Record<string, string>): string => {
  const show = (s: string): string => s.replace(TEMPLATE, (m, key: string) => (!key.startsWith("env.") && vars[key] !== undefined ? vars[key] : m));
  const q = query ? Object.entries(query).map(([k, v]) => `${k}=${show(v)}`).join("&") : "";
  return show(path) + (q ? `?${q}` : "");
};

const pointerAt = (body: unknown, pointer: string): unknown => {
  let cur = body;
  for (const raw of pointer.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
};

const is2xx = (s: number): boolean => s >= 200 && s < 300;
/**
 * The answers that mean "refused": 401, 403 and 404 (a fixed server may hide that the resource exists). Anything else
 * that is not a 2xx — a redirect, 400, 405, 410, 422, a 5xx — says nothing about access (a `PATCH {}` refused by
 * validation never reached the access check), so the case is inconclusive, never a pass.
 */
const DENIED = new Set([401, 403, 404]);
const outcomeOf = (s: number): CaseOutcome => (is2xx(s) ? "finding" : DENIED.has(s) ? "denied" : "inconclusive");
const inconclusiveDetail = (s: number): string =>
  s >= 500
    ? `the server failed (${s}); not known whether it is protected`
    : `answered ${s}, neither a refusal (401, 403, 404) nor a success; not known whether it is protected`;

/**
 * Run every check of the plan. Never throws for a failed request: a check that stops midway records its error, and
 * its cleanup has run. Findings are 2xx answers to actor B (and neighbours both actors read).
 */
export async function runTwoActorChecks(plan: TwoActorPlan, opts: TwoActorOptions): Promise<TwoActorReport> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const results: TwoActorCheckResult[] = [];
  /** Whether the current check's flow sent a request yet (so it may have created something). */
  let sentAny = false;

  /** One request through the guard. A transport failure throws: the check stops there. */
  const send = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: { text: string; type: string } | undefined,
    mustSend: boolean,
    shown: string,
  ): Promise<Response> => {
    const sent = body ? mergeHeaders({ "content-type": body.type }, headers) : headers;
    // What fetch would refuse is refused here, before anything is counted or sent, without quoting the value.
    for (const [name, value] of Object.entries(sent)) {
      const refusal = headerRefusal(name, undefined, value);
      if (refusal) throw new RequestFailed(`${method} ${shown} not sent: ${refusal}`);
    }
    try {
      new URL(base + path);
    } catch {
      throw new RequestFailed(`${method} ${shown} not sent: invalid URL`);
    }
    // The budget was reserved for the whole check before it started; the cleanup goes out even if it ran short.
    if (!(await opts.guard.acquire()) && !mustSend) throw new RequestFailed(`the request budget ran out (--max-requests ${opts.guard.maxRequests})`);
    const init: RequestInit = { method, headers: sent, redirect: "manual" };
    if (body) init.body = body.text;
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(base + path, init);
      opts.guard.recordExecuted();
      return res;
    } catch (e) {
      // Method, the path as written and a category: the text of the error is never used.
      throw new RequestFailed(`${method} ${shown} got no answer: ${failureCategory(e)}`);
    }
  };
  const json = (value: unknown): { text: string; type: string } | undefined =>
    value === undefined ? undefined : { text: JSON.stringify(value), type: "application/json" };

  /**
   * One flow step as the owner, with the flow's `expect` (plus `alsoOk`) and its captures. A flow step without
   * `expect` takes any 2xx or 3xx, as in #230; a cleanup step without `expect` is done only on a 2xx — a 302 to a
   * login page (the owner's session ended) leaves the resource where it was.
   */
  const runStep = async (flow: ApiFlow, step: FlowStep, vars: Record<string, string>, cleanup = false, alsoOk: number[] = []): Promise<void> => {
    let path = fillValue(step.path, vars, env, true) as string;
    if (step.query) path += `?${new URLSearchParams(fillValue(step.query, vars, env) as Record<string, string>).toString()}`;
    // Error text names the path without any environment value: `path` itself goes only on the wire.
    const shown = shownPath(step.path, vars, step.query);
    const label = cleanup
      ? `flow "${flow.name}" cleanup "${step.name ?? step.method}": ${step.method} ${shown}`
      : `flow "${flow.name}" step "${step.name ?? `${step.method} ${step.path}`}"`;
    const stepHeaders = fillValue(step.headers ?? {}, vars, env) as Record<string, string>;
    for (const [name, value] of Object.entries(stepHeaders)) {
      const refusal = headerRefusal(name, step.headers![name], value);
      if (refusal) throw new RequestFailed(`${step.method} ${shown} not sent: ${refusal}`);
    }
    const headers = mergeHeaders(opts.owner, stepHeaders);
    const body = step.form
      ? { text: new URLSearchParams(fillValue(step.form, vars, env) as Record<string, string>).toString(), type: "application/x-www-form-urlencoded" }
      : json(step.body === undefined ? undefined : fillValue(step.body, vars, env));
    sentAny = true;
    const res = await send(step.method, path, headers, body, cleanup, shown);
    const want = step.expect === undefined ? undefined : ([] as number[]).concat(step.expect);
    const ok = (want ? want.includes(res.status) : cleanup ? is2xx(res.status) : res.status >= 200 && res.status < 400) || alsoOk.includes(res.status);
    if (!ok) throw new RequestFailed(`${label} answered ${res.status} (want ${want ? want.join(" or ") : cleanup ? "2xx" : "2xx or 3xx"})`);
    if (!step.capture) {
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      throw new RequestFailed(`${label}: the answer is not JSON, so nothing can be captured from it`);
    }
    const missing: string[] = [];
    for (const [name, pointer] of Object.entries(step.capture)) {
      const v = pointerAt(answer, pointer);
      if (v === undefined || v === null || typeof v === "object" || String(v) === "") missing.push(`${pointer} for ${name}`);
      else vars[name] = String(v);
    }
    if (missing.length) throw new RequestFailed(`${label}: the answer has no value at ${missing.join(", ")}`);
  };

  const status = async (method: string, path: string, shown: string, headers: Record<string, string>, body?: unknown): Promise<number> => {
    const res = await send(method, path, headers, json(body), false, shown);
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  };

  for (const check of plan.file.checks) {
    const flow = plan.flows.flows.find((f) => f.name === check.flow)!;
    const result: TwoActorCheckResult = { check: `${check.flow} ${check.resource}`, flow: flow.name, cleanupErrors: [], cases: [] };
    results.push(result);
    const wstgDirect = opts.role === "lower" ? WSTG_PRIVILEGE_ESCALATION : WSTG_IDOR;
    const probeMethod: Record<TwoActorProbe, string> = { read: "GET", change: check.change.method, delete: "DELETE", neighbours: "GET" };

    // The guard's own rules, asked before anything is created: the check creates data, and its cleanup must be allowed.
    if (!opts.guard.allowsMutations) {
      result.notRun = "mutations disabled — the owner's flow creates data; pass --allow-mutations for a staging address";
      opts.guard.recordSkip("mutations disabled");
      continue;
    }
    const refused = [...flow.steps, ...flow.cleanup].find((s) => !opts.guard.allowsMethod(s.method) || !opts.guard.allowsPath(s.path));
    if (refused) {
      result.notRun = `not allowed — flow "${flow.name}" sends ${refused.method} ${refused.path}, which --allowed-methods/--allowed-paths refuse`;
      opts.guard.recordSkip("not allowed");
      continue;
    }
    const probes = check.probes.filter((p) => {
      const allowed = opts.guard.allowsMethod(probeMethod[p]) && opts.guard.allowsPath(check.resource);
      if (!allowed) {
        result.cases.push({ check: result.check, probe: p, wstgId: p === "neighbours" ? WSTG_IDOR : wstgDirect, method: probeMethod[p], path: check.resource, outcome: "skipped", detail: "not allowed by --allowed-methods/--allowed-paths" });
        opts.guard.recordSkip("not allowed");
      }
      return allowed;
    });
    const needed = flow.steps.length + flow.cleanup.length + probes.filter((p) => p !== "neighbours").length + (probes.includes("neighbours") ? 4 * check.neighbours : 0);
    const left = opts.guard.maxRequests - opts.guard.report().requestsUsed;
    if (needed > left) {
      result.notRun = `budget exhausted — the check needs up to ${needed} request(s), ${left} left (raise --max-requests)`;
      opts.guard.recordSkip("budget exhausted");
      continue;
    }

    const vars: Record<string, string> = { uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
    let deletedByOther = false;
    sentAny = false;
    try {
      for (const step of flow.steps) await runStep(flow, step, vars);
      const path = fillValue(check.resource, vars, env, true) as string;
      // What the report and error text name: no environment value in it.
      const shown = shownPath(check.resource, vars);
      const record = (probe: TwoActorProbe, method: string, at: string, s: number, what: string, wstgId = wstgDirect): void => {
        const outcome = outcomeOf(s);
        const detail =
          outcome === "finding"
            ? `the other actor ${what} the owner's resource (${s})`
            : outcome === "denied"
              ? `refused (${s})`
              : inconclusiveDetail(s);
        result.cases.push({ check: result.check, probe, wstgId, method, path: at, outcome, status: s, detail });
      };
      // Delete last: after it the resource may be gone.
      if (probes.includes("read")) record("read", "GET", shown, await status("GET", path, shown, opts.other), "read");
      if (probes.includes("change")) {
        const body = fillValue(check.change.body, vars, env);
        record("change", check.change.method, shown, await status(check.change.method, path, shown, opts.other, body), "changed");
      }
      if (probes.includes("neighbours")) {
        const idName = [...check.resource.matchAll(TEMPLATE)].pop()![1]!;
        const id = vars[idName] ?? "";
        if (!/^\d+$/.test(id)) {
          result.cases.push({ check: result.check, probe: "neighbours", wstgId: WSTG_IDOR, method: "GET", path: shown, outcome: "skipped", detail: `the id ${JSON.stringify(id)} is not a number` });
        } else {
          for (let d = 1; d <= check.neighbours; d++) {
            for (const n of [Number(id) - d, Number(id) + d]) {
              if (n < 0) continue;
              const wire = fillValue(check.resource, { ...vars, [idName]: String(n) }, env, true) as string;
              const at = shownPath(check.resource, { ...vars, [idName]: String(n) });
              const s = await status("GET", wire, at, opts.other);
              if (!is2xx(s)) {
                const outcome = outcomeOf(s);
                result.cases.push({ check: result.check, probe: "neighbours", wstgId: WSTG_IDOR, method: "GET", path: at, outcome, status: s, detail: outcome === "denied" ? `refused or absent (${s})` : inconclusiveDetail(s) });
                continue;
              }
              // B can read it: a finding only when A can too — an id B owns refuses A on a fixed server.
              const o = await status("GET", wire, at, opts.owner);
              const ownerOutcome = outcomeOf(o);
              result.cases.push({
                check: result.check,
                probe: "neighbours",
                wstgId: WSTG_IDOR,
                method: "GET",
                path: at,
                outcome: ownerOutcome,
                status: s,
                ownerStatus: o,
                detail:
                  ownerOutcome === "finding"
                    ? `both actors read id ${n}, so it is private to neither (${s} / ${o})`
                    : ownerOutcome === "denied"
                      ? `the other actor reads id ${n} and the owner is refused (${o}): it is the other actor's own`
                      : `the other actor reads id ${n}; the owner's answer (${o}) is neither a refusal nor a success, so not known whose it is`,
              });
            }
          }
        }
      }
      if (probes.includes("delete")) {
        const s = await status("DELETE", path, shown, opts.other);
        deletedByOther = is2xx(s);
        record("delete", "DELETE", shown, s, "deleted");
      }
    } catch (e) {
      result.error = reportable(e);
    } finally {
      // The flow's own cleanup, as the owner, whatever happened above. A step whose values were never captured cannot
      // be sent; once the flow sent anything, that is a cleanup error, since what it created may still be there.
      for (const step of flow.cleanup) {
        const names = [...JSON.stringify(step).matchAll(TEMPLATE)].map((m) => m[1]!);
        const missing = [...new Set(names.filter((n) => !n.startsWith("env.") && n !== "uid" && !(n in vars)))];
        if (missing.length) {
          if (sentAny) {
            const which = missing.map((n) => `{{${n}}}`).join(", ");
            result.cleanupErrors.push(
              `flow "${flow.name}" cleanup "${step.name ?? step.method}": ${step.method} ${step.path} was not sent: ${which} was never captured, ` +
                `so the resource ${check.resource} the flow created may still be on the server`,
            );
          }
          continue;
        }
        try {
          // Only after the other actor's DELETE went through does a 404/410 here mean the cleanup's goal is reached.
          await runStep(flow, step, vars, true, deletedByOther ? [404, 410] : []);
        } catch (e) {
          result.cleanupErrors.push(reportable(e));
        }
      }
    }
  }
  return { baseUrl: opts.baseUrl, role: opts.role, checks: results, findings: results.flatMap((r) => r.cases).filter((c) => c.outcome === "finding").length };
}

/** Console lines: one per case, with its WSTG id; then what was not run, what stopped, and what the cleanup left. */
export function renderTwoActorReport(r: TwoActorReport): string[] {
  const lines = ["", `=== Two-actor check (${r.role === "lower" ? "lower role" : "two users"}) against ${r.baseUrl} ===`];
  const mark: Record<CaseOutcome, string> = { finding: "✗", denied: "✓", inconclusive: "?", skipped: "⊘" };
  for (const c of r.checks) {
    lines.push(`  ${c.check} (flow "${c.flow}")`);
    if (c.notRun) lines.push(`    ⊘ not run: ${c.notRun}`);
    for (const k of c.cases) lines.push(`    ${mark[k.outcome]} [${k.wstgId}] ${k.probe}: ${k.method} ${k.path} — ${k.detail}`);
    if (c.error) lines.push(`    ✗ stopped: ${c.error} (the cleanup ran)`);
    for (const e of c.cleanupErrors) lines.push(`    ✗ cleanup failed, the data may still be there: ${e}`);
  }
  const all = r.checks.flatMap((c) => c.cases);
  lines.push(
    `  ${r.findings} finding(s) · ${all.filter((c) => c.outcome === "denied").length} refused · ` +
      `${all.filter((c) => c.outcome === "inconclusive").length} inconclusive · ${all.filter((c) => c.outcome === "skipped").length} skipped`,
  );
  return lines;
}

/** Whether a report should fail the run: a finding, an inconclusive case, a check that stopped or a cleanup that failed. */
export function twoActorFailed(r: TwoActorReport): boolean {
  return r.checks.some((c) => c.error !== undefined || c.cleanupErrors.length > 0 || c.cases.some((k) => k.outcome === "finding" || k.outcome === "inconclusive"));
}

