/**
 * #227 — find an OpenAPI spec the server already serves, for `cairn api --base-url <url>` without
 * `--spec`. Many frameworks publish theirs at a well-known address (FastAPI, NestJS swagger, Spring
 * springdoc, ASP.NET Swashbuckle); this tries those addresses on the base URL in order and takes the
 * first answer `ingestOpenApi` reads without an error.
 *
 * Every try is a GET with no body, carries the run's headers (method-override ones dropped), takes a slot of the run's request
 * budget and rate limit, never follows a redirect, and has its own deadline. A path `--allowed-paths` does not allow is
 * skipped, not asked. A found spec's external `$ref`s are not followed (`ingestOpenApi` gets the served text only).
 */
import { ingestOpenApi, type ApiModel } from "./openapi.js";
import { METHOD_OVERRIDE_HEADER, type RequestGuard } from "./guard.js";

/** The well-known addresses, tried in this order on the base URL. */
export const SPEC_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/v3/api-docs",
  "/v2/api-docs",
  "/api-docs",
  "/swagger/v1/swagger.json",
  "/docs/openapi.json",
] as const;

/**
 * Deadline for one try, headers and body together. A served spec is one document, normally back in
 * well under a second; 5 s leaves room for a framework that builds it on the first request, while a
 * base that never answers costs at most 8 × 5 s instead of hanging the run.
 */
export const SPEC_PROBE_TIMEOUT_MS = 5_000;

/** One address: what came back when it was tried without finding a spec, or why it was not asked. */
export interface SpecTry {
  url: string;
  outcome: string;
}

/** `tried`: addresses asked that gave no spec; `skipped`: addresses not asked (`--allowed-paths`). */
export type SpecDiscovery = { tried: SpecTry[]; skipped: SpecTry[] } & (
  | { found: true; url: string; model: ApiModel }
  /** `stopped`: why the lookup ended before every address was tried (a guardrail). */
  | { found: false; stopped?: string }
);

export interface DiscoverOptions {
  /** `--base-url`, already checked by `parseBaseUrl`. */
  baseUrl: string;
  /** The headers the run sends: api-scope knowledge, `--header`, Basic auth from the URL. */
  headers: Record<string, string>;
  /** The run's guardrails: the lookup's tries count against the same budget and rate limit. */
  guard: RequestGuard;
  /** Per-try deadline (ms); default {@link SPEC_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export async function discoverSpec(opts: DiscoverOptions): Promise<SpecDiscovery> {
  const timeoutMs = opts.timeoutMs ?? SPEC_PROBE_TIMEOUT_MS;
  const base = new URL(opts.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const tried: SpecTry[] = [];
  const skipped: SpecTry[] = [];
  // Read-only whatever the run allows: an override header (`X-HTTP-Method-Override: DELETE`) would turn the GET into another method.
  const headers = Object.fromEntries(Object.entries(opts.headers).filter(([k]) => !METHOD_OVERRIDE_HEADER.test(k)));
  const stripped = Object.keys(opts.headers).length - Object.keys(headers).length;
  if (!opts.guard.allowsMethod("GET")) {
    return { found: false, tried, skipped, stopped: "--allowed-methods does not include GET, the only method the lookup sends" };
  }
  for (const path of SPEC_PATHS) {
    // On the base's path, its query kept: `https://h/api?key=k` → `https://h/api/openapi.json?key=k`.
    const at = new URL(base);
    at.pathname = `${basePath}${path}`;
    const url = at.href;
    if (!opts.guard.allowsPath(path)) {
      skipped.push({ url, outcome: "not in --allowed-paths" });
      continue;
    }
    if (!(await opts.guard.acquire())) {
      return { found: false, tried, skipped, stopped: `the request budget ran out (--max-requests ${opts.guard.maxRequests})` };
    }
    if (stripped) opts.guard.recordStripped(stripped);
    const got = await tryAddress(url, headers, timeoutMs);
    if (typeof got !== "string") return { found: true, url, model: got, tried, skipped };
    tried.push({ url, outcome: got });
  }
  return { found: false, tried, skipped };
}

/** The model when `url` serves a spec, else a short reason why not. */
async function tryAddress(url: string, headers: Record<string, string>, timeoutMs: number): Promise<ApiModel | string> {
  let status: number;
  let text: string;
  try {
    // A GET with no body (override headers already dropped): a lookup never changes anything on the target.
    const res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    if (status < 200 || status > 299) {
      await res.body?.cancel();
      return status < 400 && status >= 300 ? `${status} redirect, not followed` : String(status);
    }
    text = await res.text(); // still under the same deadline: a body that stalls is cut off too
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "TimeoutError") return `no answer within ${timeoutMs / 1000} s`;
    return err.cause?.code ?? err.cause?.message ?? err.message;
  }
  try {
    return await ingestOpenApi(url, text);
  } catch (e) {
    return `${status}, not an OpenAPI 3.x spec (${(e as Error).message.split("\n")[0]})`;
  }
}

/** Deadline for reading the spec a user named with `--spec <url>`: one document, but a slow dev server may build it first. */
export const SPEC_READ_TIMEOUT_MS = 15_000;

/**
 * #234: the text of the spec at `url`, read the way the lookup reads its tries (GET, no body, run headers
 * without method-override ones, no redirect, a deadline). On a refusal `message` says what happened — the
 * status, the redirect not followed, the timeout — and how to go on, never a `$ref` error. The caller
 * counts the request against the run's guard.
 */
export async function readSpecFromUrl(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = SPEC_READ_TIMEOUT_MS,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const sent = Object.fromEntries(Object.entries(headers).filter(([k]) => !METHOD_OVERRIDE_HEADER.test(k)));
  try {
    const res = await fetch(url, { method: "GET", headers: sent, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const status = res.status;
    if (status >= 200 && status <= 299) return { ok: true, text: await res.text() };
    await res.body?.cancel();
    if (status >= 300 && status < 400) {
      const to = res.headers.get("location");
      return {
        ok: false,
        message: `the server answered ${status}${to ? ` and pointed to ${to}` : ""}; a redirect is not followed. Give the address it points to as --spec.`,
      };
    }
    const hint =
      status === 401 || status === 403
        ? " The spec needs a sign-in: pass it with --header (for example --header \"Authorization: Bearer <token>\") or as api-scope knowledge."
        : "";
    return { ok: false, message: `the server answered ${status}.${hint}` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "TimeoutError") return { ok: false, message: `no answer within ${timeoutMs / 1000} s.` };
    return { ok: false, message: `the address could not be reached (${err.cause?.code ?? err.cause?.message ?? err.message}).` };
  }
}
