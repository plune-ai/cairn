/**
 * #229 — the application's API requests, seen while `explore` / `design` drive the UI, folded into an OpenAPI draft.
 *
 * The lib backend hands every response of its browser context to {@link ApiTrafficRecorder.note}: the requests a
 * click starts (#224) and those made while pages load. Only API traffic is kept — no page, script, style, image or
 * font — and only on the origins allowed: the run's `--url` and those given with `--api-origin`. Analytics, a CDN
 * or a sign-in provider stay out.
 *
 * A JSON response body is read once for its schema (`derived.ts`) and dropped; the recorder holds the merged shapes,
 * never a body, a header value or a query value. The values that look secret (`Authorization`, cookies, a token in a
 * query, a body or an answer) are kept aside so the writer can scrub them from the file if one rode in a name.
 */
import { DerivedSpecBuilder, DERIVED_KEY, bodyFields, exchangeSecrets, isApiTraffic, isJsonMedia, mediaType } from "../api/derived.js";

/** One response as the backend saw it. `body` reads the response text; it is called only for a JSON answer within the cap. */
export interface SeenExchange {
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  postData?: string | null;
  responseContentType?: string;
  /** The answer's length when the server said it (`content-length`). */
  responseSize?: number;
  body?: () => Promise<string>;
}

/** The largest response body read for its schema; a larger one gives the status only. */
export const MAX_BODY_BYTES = 1_000_000;
/**
 * How long {@link ApiTrafficRecorder.flush} waits for the bodies still being read. A page may hold a JSON answer open
 * (a long poll, a watch stream, a slow export): the run must still end, so a body not read by then is cut off.
 */
export const FLUSH_TIMEOUT_MS = 3_000;
/** The most secret values kept aside for the writer: a long run must not grow without end. */
const MAX_SECRETS = 5_000;

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The origins whose requests go into the spec: the run URL's, then each of `extra` (comma-separated, from
 * `--api-origin`). Throws on one that is not an http(s) URL, naming the flag.
 */
export function parseApiOrigins(runUrl: string, extra?: string): string[] {
  const out = [new URL(runUrl).origin];
  for (const raw of (extra ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`--api-origin takes http(s) origins such as https://api.example.com (got "${raw}").`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`--api-origin takes http(s) origins such as https://api.example.com (got "${raw}").`);
    }
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

export class ApiTrafficRecorder {
  private readonly builder = new DerivedSpecBuilder();
  private readonly origins: Set<string>;
  private readonly maxBodyBytes: number;
  /** Bodies being read, each with what to record if it is cut off. */
  private readonly pending = new Map<Promise<void>, { cut: boolean; cutOff: () => void }>();
  private readonly secrets = new Set<string>();
  private readonly seenOrigins = new Map<string, number>();
  private count = 0;
  private cut = 0;
  private readonly left = { static: 0, otherOrigin: 0 };

  constructor(opts: { origins: string[]; maxBodyBytes?: number }) {
    this.origins = new Set(opts.origins);
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  }

  /** Requests that went into the spec. */
  get recorded(): number {
    return this.count;
  }
  /** Requests left out: pages and static files, and API requests to an origin not allowed. */
  get leftOut(): { static: number; otherOrigin: number } {
    return { ...this.left };
  }
  /** Response bodies {@link flush} stopped waiting for: those requests are kept with method, path and status only. */
  get cutOff(): number {
    return this.cut;
  }
  /** Operations the recorded requests make. */
  get operations(): number {
    return this.builder.size;
  }

  note(x: SeenExchange): void {
    let u: URL;
    try {
      u = new URL(x.url);
    } catch {
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return; // data:, blob:, chrome-extension:
    if (!isApiTraffic({ url: x.url, resourceType: x.resourceType, mimeType: x.responseContentType })) {
      this.left.static += 1;
      return;
    }
    if (!this.origins.has(u.origin)) {
      this.left.otherOrigin += 1;
      return;
    }
    this.count += 1;
    this.seenOrigins.set(u.origin, (this.seenOrigins.get(u.origin) ?? 0) + 1);
    const headers = Object.entries(x.requestHeaders ?? {});
    const fields: [string, string][] = [...u.searchParams];
    const reqType = mediaType(headers.find(([k]) => k.toLowerCase() === "content-type")?.[1]);
    let request: { contentType?: string; body?: unknown } | undefined;
    if (x.postData) {
      if (reqType === "application/x-www-form-urlencoded") {
        const form = [...new URLSearchParams(x.postData)];
        fields.push(...form);
        request = { contentType: reqType, body: Object.fromEntries(form.map(([k]) => [k, ""])) };
      } else {
        const parsed = parse(x.postData);
        if (parsed !== undefined) fields.push(...bodyFields(parsed));
        request = parsed !== undefined ? { contentType: reqType ?? "application/json", body: parsed } : { contentType: reqType ?? "text/plain" };
      }
    }
    const base = {
      method: x.method,
      path: u.pathname,
      queryKeys: [...new Set(u.searchParams.keys())],
      ...(x.status ? { status: x.status } : {}),
      ...(request ? { request } : {}),
    };
    const resType = mediaType(x.responseContentType);
    const readable = x.body && isJsonMedia(resType) && (x.responseSize === undefined || x.responseSize <= this.maxBodyBytes);
    if (!readable) {
      this.keep(exchangeSecrets({ headers, fields }));
      this.builder.add(base);
      return;
    }
    const entry = {
      cut: false,
      cutOff: (): void => {
        this.keep(exchangeSecrets({ headers, fields }));
        this.builder.add(base);
      },
    };
    const p = x.body!()
      .then(
        (text) => {
          if (entry.cut) return;
          const parsed = text.length <= this.maxBodyBytes ? parse(text) : undefined;
          if (parsed !== undefined) fields.push(...bodyFields(parsed));
          this.builder.add({ ...base, ...(parsed !== undefined ? { response: { contentType: resType, body: parsed } } : {}) });
        },
        () => {
          if (!entry.cut) this.builder.add(base); // a redirect or a page gone: the status is still worth having
        },
      )
      .finally(() => {
        if (!entry.cut) this.keep(exchangeSecrets({ headers, fields }));
        this.pending.delete(p);
      });
    this.pending.set(p, entry);
  }

  /**
   * Waits for the bodies still being read, at most `timeoutMs`. A body not read by then is cut off: its request is
   * recorded with method, path and status only ({@link cutOff} counts them), and a later answer is ignored.
   */
  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), timeoutMs);
    });
    try {
      while (this.pending.size > 0) {
        if ((await Promise.race([Promise.allSettled([...this.pending.keys()]), late])) === "late") break;
      }
    } finally {
      clearTimeout(timer);
    }
    for (const [p, entry] of this.pending) {
      entry.cut = true;
      entry.cutOff();
      this.cut += 1;
      this.pending.delete(p);
    }
  }

  /** The OpenAPI draft and the values to scrub from it. Call {@link flush} first. */
  spec(info: { title: string }): { doc: Record<string, unknown>; secrets: string[] } {
    const servers = [...this.seenOrigins].sort((a, b) => b[1] - a[1]).map(([o]) => o);
    const doc = this.builder.toOpenApi(
      {
        title: info.title,
        description: `Derived from the API requests Cairn saw while exploring the UI: what is marked ${DERIVED_KEY} was inferred from the recorded traffic, not described by a schema.`,
      },
      servers,
    );
    return { doc, secrets: [...this.secrets].sort((a, b) => b.length - a.length) };
  }

  private keep(values: string[]): void {
    for (const v of values) if (this.secrets.size < MAX_SECRETS) this.secrets.add(v);
  }
}
