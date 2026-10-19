/**
 * #196 — request guardrails for `cairn api --base-url`: what may be sent to the target, how many
 * requests, how fast, and where. Keeps a bare `cairn api --base-url <url>` run from changing data,
 * leaving the host or flooding the target.
 *
 * One {@link RequestGuard} is shared by a whole run (cases AND scenario steps), so the budget and the
 * rate limit hold regardless of how many `runApiCases` calls are in flight. Pure policy + counters —
 * the runner asks it before every send; it never touches the network itself.
 */
import type { ApiCase } from "./cases.js";

/**
 * The only methods that run without `--allow-mutations`. An allow-list, not a deny-list: TRACE, PURGE,
 * LINK, a lower-case `post` or any custom verb counts as mutating until proven otherwise.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Headers that make a server treat a GET as another method (`X-HTTP-Method-Override: DELETE`). */
export const METHOD_OVERRIDE_HEADER = /^x-http-method(-override)?$|^x-method-override$/i;
/** Query parameter some frameworks use for the same trick (`?_method=DELETE`). */
export const METHOD_OVERRIDE_PARAM = /^_method$/i;
/** Adversarial styles that only make sense as mutating probes — they need `--allow-mutations`. */
const MUTATING_STYLES: ReadonlySet<string> = new Set(["psycho", "hacker"]);

export const DEFAULT_MAX_REQUESTS = 300;
export const DEFAULT_RPS = 5;
/** Process exit code when the request budget ran out before every case was sent (1 = failed test). */
export const BUDGET_EXIT_CODE = 4;
/** Process exit code when the guardrails kept EVERY case off the wire: nothing was tested, so it is not a pass. */
export const NOTHING_SENT_EXIT_CODE = 5;
/** Lowest accepted --rps: below this a run of the default budget would take hours. */
export const MIN_RPS = 0.01;

export type SkipReason = "mutations disabled" | "not allowed" | "budget exhausted";

export interface GuardOptions {
  allowMutations?: boolean;
  /** Method allow-list; absent = every method the other rules permit. */
  allowedMethods?: string[];
  /** Path masks (`*` = within a segment, `**` = across segments) matched against the spec path. */
  allowedPaths?: string[];
  /** Hard cap on sends, retries included (default 300). */
  maxRequests?: number;
  /** Requests per second for the whole run (default 5). */
  rps?: number;
  /** Injected for tests; default `Date.now` / `setTimeout`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GuardrailReport {
  /** Cases that reached the network at least once. */
  executed: number;
  skipped: Partial<Record<SkipReason, number>>;
  blocked: { name: string; reason: string }[];
  redirects: { name: string; status: number; location?: string }[];
  requestsUsed: number;
  maxRequests: number;
  rps: number;
  allowMutations: boolean;
  budgetExhausted: boolean;
  /** Method-override headers / `_method` params removed from non-mutating requests. */
  overridesStripped: number;
}

/** Header names whose values are secrets — masked in evidence, reports and the log. */
export const SENSITIVE = /authorization|cookie|api[-_]?key|token|secret|password/i;

const MIN_SECRET_LENGTH = 4;
/** Values too common to be worth masking (masking them would mangle ordinary output). */
const COMMON_VALUES = new Set(["true", "false", "null", "none", "bearer", "basic", "token", "undefined", "application/json"]);

/** The credential parts of one header value: the whole value, the part after `Scheme `, a decoded Basic pair, cookie values. */
function secretParts(name: string, value: string): string[] {
  const v = value.trim();
  const parts = [v];
  const credential = /^\S+\s+(\S.*)$/.exec(v)?.[1];
  if (credential) parts.push(credential);
  if (/^basic\s+/i.test(v) && credential) {
    const decoded = Buffer.from(credential, "base64").toString("utf8");
    if (decoded.includes(":")) parts.push(decoded, decoded.slice(decoded.indexOf(":") + 1));
  }
  if (/cookie/i.test(name)) {
    for (const pair of v.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) parts.push(pair.slice(eq + 1).trim());
    }
  }
  return parts;
}

/**
 * Secret values worth scrubbing from output: sensitive header values, the credential of `Scheme credential`,
 * a decoded Basic `user:pass` and its password, each cookie value, and the URL-encoded form of each.
 */
export function collectSecrets(headers: Record<string, string>): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const v = raw.trim();
    if (v.length < MIN_SECRET_LENGTH || COMMON_VALUES.has(v.toLowerCase())) return;
    out.add(v);
    const enc = encodeURIComponent(v);
    if (enc !== v) out.add(enc);
  };
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE.test(name)) secretParts(name, value).forEach(add);
  }
  // Longest first, so "Bearer abc" is replaced whole before "abc" alone.
  return [...out].sort((a, b) => b.length - a.length);
}

/** Sensitive headers whose secret is shorter than the masking minimum — it would be left in the output. */
export function tooShortSecrets(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name, value]) => {
      if (!SENSITIVE.test(name) || value.trim() === "") return false;
      const parts = secretParts(name, value).filter((p) => p.length > 0);
      return parts.some((p) => p.length < MIN_SECRET_LENGTH && !COMMON_VALUES.has(p.toLowerCase()));
    })
    .map(([name]) => name);
}

/** What `--base-url` is allowed to be, and the secrets that can ride in it (userinfo, sensitive query values). */
export function parseBaseUrl(raw: string): { baseUrl: string; secrets: string[]; basicAuth?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--base-url must be an absolute http(s) URL such as https://api.example.com (the value is not a valid URL).`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`--base-url must use http or https (got "${u.protocol}").`);
  }
  const secrets: string[] = [];
  let basicAuth: string | undefined;
  if (u.username || u.password) {
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    basicAuth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    secrets.push(...[`${u.username}:${u.password}`, `${user}:${pass}`, u.password, pass, basicAuth.slice(6)]);
  }
  for (const [k, v] of u.searchParams) if (SENSITIVE.test(k)) secrets.push(v, encodeURIComponent(v));
  u.username = "";
  u.password = "";
  return {
    baseUrl: u.toString().replace(/\/+$/, ""),
    secrets: [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH && !COMMON_VALUES.has(s.toLowerCase())))],
    ...(basicAuth ? { basicAuth } : {}),
  };
}

/** Replace every secret in `text` (raw and JSON-escaped form) with `***`. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    out = out.split(s).join("***");
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out = out.split(escaped).join("***");
  }
  return out;
}

/** Mask secrets inside every string of a JSON-like value (Buffers and other non-plain values are left alone). */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return maskSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, secrets)])) as T;
  }
  return value;
}

/** Compile a path mask: `*` stays inside one segment, `**` crosses segments; everything else is literal. */
function pathMask(mask: string): RegExp {
  const src = mask
    .split("**")
    .map((part) => part.split("*").map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${src}$`);
}

/** A whole number of 1 or more, or an error naming the flag. */
export function parsePositiveInt(flag: string, raw: unknown): number {
  const text = String(raw).trim();
  const n = text === "" ? Number.NaN : Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number of 1 or more (got "${String(raw)}").`);
  return n;
}

/** A number of at least `min` (fractions allowed, e.g. 0.5 requests per second), or an error naming the flag. */
export function parsePositiveNumber(flag: string, raw: unknown, min = 0): number {
  const text = String(raw).trim();
  const n = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(n) || n <= 0 || n < min) {
    throw new Error(`${flag} must be a number ${min > 0 ? `of ${min} or more` : "greater than 0"} (got "${String(raw)}").`);
  }
  return n;
}

/** Split a comma-separated flag value into trimmed, non-empty entries. */
export function parseList(raw: unknown): string[] {
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export class RequestGuard {
  readonly maxRequests: number;
  readonly rps: number;
  private readonly allowMutations: boolean;
  private readonly methods?: Set<string>;
  private readonly masks?: RegExp[];
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private used = 0;
  private nextSlot = 0;
  private exhausted = false;
  private executed = 0;
  private stripped = 0;
  private readonly skippedBy: Partial<Record<SkipReason, number>> = {};
  private readonly blockedList: GuardrailReport["blocked"] = [];
  private readonly redirectList: GuardrailReport["redirects"] = [];

  constructor(opts: GuardOptions = {}) {
    this.maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.rps = opts.rps ?? DEFAULT_RPS;
    this.allowMutations = opts.allowMutations ?? false;
    if (opts.allowedMethods?.length) this.methods = new Set(opts.allowedMethods.map((m) => m.toUpperCase()));
    if (opts.allowedPaths?.length) this.masks = opts.allowedPaths.map(pathMask);
    // Monotonic: a wall-clock step (NTP, DST) must not open the rate limiter.
    this.now = opts.now ?? (() => performance.now());
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Policy check before anything is sent: why this case must not run, if it must not. */
  check(c: ApiCase): SkipReason | undefined {
    if (this.methods && !this.methods.has(c.method.toUpperCase())) return "not allowed";
    if (this.masks && !this.masks.some((m) => m.test(c.path))) return "not allowed";
    const mutating = !READ_ONLY_METHODS.has(c.method.toUpperCase()) || MUTATING_STYLES.has(c.adversarialStyle ?? "");
    if (mutating && !this.allowMutations) return "mutations disabled";
    return undefined;
  }

  /**
   * Take one slot of the budget and wait for the next free rate-limit slot. `false` = the budget is
   * spent and nothing may be sent. The slot is reserved synchronously, so concurrent callers queue up
   * 1/rps apart instead of bursting.
   */
  async acquire(): Promise<boolean> {
    if (this.used >= this.maxRequests) {
      this.exhausted = true;
      return false;
    }
    this.used += 1;
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + 1000 / this.rps;
    if (slot > now) await this.sleepFn(slot - now);
    return true;
  }

  get allowsMutations(): boolean {
    return this.allowMutations;
  }

  recordStripped(n: number): void {
    this.stripped += n;
  }

  get budgetExhausted(): boolean {
    return this.exhausted;
  }

  recordSkip(reason: SkipReason): void {
    this.skippedBy[reason] = (this.skippedBy[reason] ?? 0) + 1;
  }
  recordBlocked(name: string, reason: string): void {
    this.blockedList.push({ name, reason });
  }
  recordRedirect(name: string, status: number, location?: string | null): void {
    this.redirectList.push({ name, status, ...(location ? { location } : {}) });
  }
  recordExecuted(): void {
    this.executed += 1;
  }

  report(): GuardrailReport {
    return {
      executed: this.executed,
      skipped: { ...this.skippedBy },
      blocked: [...this.blockedList],
      redirects: [...this.redirectList],
      requestsUsed: this.used,
      maxRequests: this.maxRequests,
      rps: this.rps,
      allowMutations: this.allowMutations,
      budgetExhausted: this.exhausted,
      overridesStripped: this.stripped,
    };
  }
}

/** Console/report lines for the guardrail summary: executed / skipped (by reason) / blocked, budget used. */
export function renderGuardrails(g: GuardrailReport): string[] {
  const skippedTotal = Object.values(g.skipped).reduce((a, b) => a + (b ?? 0), 0);
  const byReason = Object.entries(g.skipped)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(", ");
  const lines = [
    "",
    "=== Guardrails ===",
    `  executed ${g.executed} · skipped ${skippedTotal}${byReason ? ` (${byReason})` : ""} · blocked ${g.blocked.length}`,
    `  request budget: ${g.requestsUsed}/${g.maxRequests} used (retries included) · rate limit ${g.rps} req/s`,
  ];
  if (g.skipped["mutations disabled"]) {
    lines.push(`  ${g.skipped["mutations disabled"]} mutating case(s) were not sent — pass --allow-mutations to run them`);
  }
  if (g.overridesStripped) lines.push(`  ${g.overridesStripped} method-override header/param(s) removed from read-only requests`);
  if (g.budgetExhausted) lines.push("  budget exhausted — the remaining cases were not sent (raise --max-requests)");
  for (const b of g.blocked) lines.push(`  blocked ${b.name}: ${b.reason}`);
  for (const r of g.redirects) lines.push(`  redirect not followed: ${r.name} → ${r.status}${r.location ? ` ${r.location}` : ""}`);
  return lines;
}
