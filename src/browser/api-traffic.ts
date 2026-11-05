/**
 * #229 — the application's API requests, seen while `explore` / `design` drive the UI, folded into an OpenAPI draft.
 *
 * The lib backend hands every response of its browser context to {@link ApiTrafficRecorder.note}: the requests a
 * click starts (#224) and those made while pages load. Only API traffic is kept — no page, script, style, image or
 * font — and only on the origins allowed: the run's `--url` and those given with `--api-origin`. Analytics, a CDN
 * or a sign-in provider stay out.
 *
 * A JSON response body is read once for its schema and its values (`derived.ts`) and dropped. The recorder holds the
 * merged shapes, the words of paths that passed their form and a digest of every value seen; never a body, a header
 * value or a query value as such. What reaches the file is decided when the document is built.
 */
import {
  DerivedSpecBuilder,
  DERIVED_KEY,
  DERIVED_SPEC_FILE,
  TooManyValues,
  formParts,
  isApiTraffic,
  isJsonMedia,
  mediaType,
  writeDerivedSpec,
} from "../api/derived.js";

/** One response as the backend saw it. `body` reads the response text; it is called only for a JSON answer within the cap. */
export interface SeenExchange {
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  /** Every header of the request and the response as they travelled, cookies included; asked for on API traffic only. */
  allHeaders?: () => Promise<[string, string][]>;
  postData?: string | null;
  responseContentType?: string;
  /** The answer's length when the server said it (`content-length`). */
  responseSize?: number;
  body?: () => Promise<string>;
}

/**
 * The largest body parsed. An answer that says it is larger is not read. One that does not say (chunked, no
 * `content-length`) can only be read whole, into memory, and is dropped after if it is larger.
 */
export const MAX_BODY_BYTES = 1_000_000;
/**
 * How long {@link ApiTrafficRecorder.flush} waits for the bodies still being read. A page may hold a JSON answer open
 * (a long poll, a watch stream, a slow export): the run must still end, so a body not read by then is cut off.
 */
export const FLUSH_TIMEOUT_MS = 3_000;
/** The title of a draft from the traffic: the host and the port stay out of the file, and the runner does not read `servers`. */
export const DRAFT_TITLE = "API draft (from the UI traffic)";
const FORM = "application/x-www-form-urlencoded";
/** Refused origins counted one by one, for the log: a long run must not grow without end. */
const MAX_REFUSED_ORIGINS = 1_000;
const NAMED_REFUSED_ORIGINS = 3;

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The origins whose requests go into the spec: the run URL's, then each of `extra` (comma-separated, from
 * `--api-origin`). Throws on one that is not an http(s) origin, naming the flag and the entry's place, never its text:
 * it may hold a password. A `--url` that is no URL gives no origin here and fails where the run reads it, with a report.
 */
export function parseApiOrigins(runUrl: string, extra?: string): string[] {
  const out: string[] = [];
  try {
    out.push(new URL(runUrl).origin);
  } catch {
    // the run's own failure says it
  }
  const entries = (extra ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const [i, raw] of entries.entries()) {
    const refuse = (why: string): Error => new Error(`--api-origin takes http(s) origins such as https://api.example.com: entry ${i + 1} of the list ${why}.`);
    if (raw.includes("*")) throw refuse("has a * in it, name each origin");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw refuse("is not a URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw refuse("is not http or https");
    if (u.username || u.password) throw refuse("holds a user or a password");
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

export class ApiTrafficRecorder {
  private readonly builder: DerivedSpecBuilder;
  private readonly origins: Set<string>;
  private readonly maxBodyBytes: number;
  /** Bodies being read, each with what to record if it is cut off. */
  private readonly pending = new Map<Promise<void>, { cut: boolean; cutOff: () => void }>();
  private readonly headerReads = new Set<Promise<void>>();
  private readonly refused = new Map<string, number>();
  private count = 0;
  private cut = 0;
  private readonly left = { static: 0, otherOrigin: 0 };

  constructor(opts: { origins: string[]; maxBodyBytes?: number; maxKnownValues?: number }) {
    this.builder = new DerivedSpecBuilder({ maxKnownValues: opts.maxKnownValues });
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
  /** The origins not allowed that were asked most, with their counts, for the log. */
  get otherOrigins(): [string, number][] {
    return [...this.refused].sort((a, b) => b[1] - a[1]).slice(0, NAMED_REFUSED_ORIGINS);
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
    const known = this.builder.known;
    // A value counts wherever it was seen, on a request left out too, and whatever becomes of the answer.
    const query = formParts(u.search.slice(1));
    for (const [, v] of query.fields) known.add(v);
    for (const v of query.bare) known.add(v);
    const headers = Object.entries(x.requestHeaders ?? {});
    for (const [k, v] of headers) known.header(k, v);
    if (!isApiTraffic({ url: x.url, resourceType: x.resourceType, mimeType: x.responseContentType })) {
      this.left.static += 1;
      return;
    }
    if (!this.origins.has(u.origin)) {
      this.left.otherOrigin += 1;
      if (this.refused.has(u.origin) || this.refused.size < MAX_REFUSED_ORIGINS) this.refused.set(u.origin, (this.refused.get(u.origin) ?? 0) + 1);
      return;
    }
    this.count += 1;
    if (x.allHeaders) this.readHeaders(x.allHeaders);
    const request = this.requestOf(x.postData, mediaType(headers.find(([k]) => k.toLowerCase() === "content-type")?.[1]));
    const base = {
      method: x.method,
      path: u.pathname,
      queryKeys: [...new Set(query.fields.map(([k]) => k))],
      ...(x.status ? { status: x.status } : {}),
      ...(request ? { request } : {}),
    };
    const resType = mediaType(x.responseContentType);
    const readable = x.body && isJsonMedia(resType) && (x.responseSize === undefined || x.responseSize <= this.maxBodyBytes);
    if (!readable) {
      this.builder.add(base);
      return;
    }
    const entry = { cut: false, cutOff: (): void => this.builder.add(base) };
    const p = x.body!()
      .then(
        (text) => {
          if (entry.cut) return;
          const parsed = text.length <= this.maxBodyBytes ? parse(text) : undefined;
          this.builder.add({ ...base, ...(parsed !== undefined ? { response: { contentType: resType, body: parsed } } : {}) });
        },
        () => {
          if (!entry.cut) this.builder.add(base); // a redirect or a page gone: the status is still worth having
        },
      )
      .finally(() => {
        this.pending.delete(p);
      });
    this.pending.set(p, entry);
  }

  /**
   * A request's body as the builder takes it. One over the limit is not parsed. A form gives the names and the values of
   * its `name=value` parts; a JSON or a text body sent as a form has no such part, so no name, and its values still count.
   */
  private requestOf(postData: string | null | undefined, type: string | undefined): { contentType?: string; body?: unknown } | undefined {
    if (!postData) return undefined;
    if (postData.length > this.maxBodyBytes) return { contentType: type ?? "text/plain" };
    const known = this.builder.known;
    const parsed = parse(postData);
    if (type === FORM) {
      known.json(parsed);
      const form = formParts(postData);
      for (const [, v] of form.fields) known.add(v);
      for (const v of form.bare) known.add(v);
      return { contentType: type, body: Object.fromEntries(form.fields.map(([k]) => [k, ""])) };
    }
    if (parsed !== undefined) return { contentType: type ?? "application/json", body: parsed }; // the builder reads its values
    known.add(postData);
    return { contentType: type ?? "text/plain" };
  }

  private readHeaders(read: () => Promise<[string, string][]>): void {
    const known = this.builder.known;
    const h = read()
      .then(
        (all) => {
          for (const [k, v] of all) known.header(k, v);
        },
        () => undefined, // a page gone: the headers `note` got are what there is
      )
      .finally(() => {
        this.headerReads.delete(h);
      });
    this.headerReads.add(h);
  }

  /**
   * Waits for the bodies and headers still being read, at most `timeoutMs`. A body not read by then is cut off: its
   * request is recorded with method, path and status only ({@link cutOff} counts them), and a later answer is ignored.
   */
  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), timeoutMs);
    });
    try {
      while (this.pending.size + this.headerReads.size > 0) {
        if ((await Promise.race([Promise.allSettled([...this.pending.keys(), ...this.headerReads]), late])) === "late") break;
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

  /** The OpenAPI draft, checked against all the values seen and the run's own secrets. Call {@link flush} first. */
  spec(runSecrets: readonly string[] = []): Record<string, unknown> {
    for (const s of runSecrets) this.builder.known.secret(s);
    return this.builder.toOpenApi({
      title: DRAFT_TITLE,
      description: `Derived from the API requests Cairn saw while exploring the UI: what is marked ${DERIVED_KEY} was inferred from the recorded traffic, not described by a schema.`,
    });
  }
}

/**
 * #229: the API requests the run saw, folded into an OpenAPI draft → openapi.derived.json in the run dir, checked against
 * the traffic's values and the run's secrets (knowledge, environment). Nothing is written when none was seen; the cli
 * backend records nothing (`recorder` undefined). The draft is a by-product: a failure here goes to the log, and the run
 * goes on. The log gets the error's code and not its message.
 */
export async function writeTrafficSpec(
  recorder: ApiTrafficRecorder | undefined,
  dir: string,
  url: string,
  secrets: readonly string[],
  onProgress: (event: string) => void,
): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.flush();
    const { static: statics, otherOrigin } = recorder.leftOut;
    const named = recorder.otherOrigins.map(([o, n]) => `${o} (${n})`).join(", ");
    const left = [
      ...(statics ? [`${statics} page/static request(s)`] : []),
      ...(otherOrigin ? [`${otherOrigin} to other origins: ${named} (allow one with --api-origin)`] : []),
    ];
    const cut = recorder.cutOff;
    if (cut) left.push(`${cut} response ${cut === 1 ? "body" : "bodies"} cut off after ${FLUSH_TIMEOUT_MS / 1000}s (recorded without a schema)`);
    const leftText = left.length ? `; left out: ${left.join(", ")}` : "";
    if (recorder.recorded === 0) {
      onProgress(`api — no API request seen on ${new URL(url).origin}, no ${DERIVED_SPEC_FILE}${leftText}`);
      return;
    }
    const doc = recorder.spec(secrets);
    if (recorder.operations === 0) {
      onProgress(`api — ${recorder.recorded} API request(s) made no operation, no ${DERIVED_SPEC_FILE}${leftText}`);
      return;
    }
    await writeDerivedSpec(dir, doc);
    onProgress(
      `api — ${recorder.recorded} API request(s) → ${recorder.operations} operation(s) → ${DERIVED_SPEC_FILE} (inferred, x-cairn-derived)${leftText}`,
    );
  } catch (e) {
    if (e instanceof TooManyValues) onProgress(`api — no ${DERIVED_SPEC_FILE}: ${e.message}`);
    else onProgress(`api — could not write ${DERIVED_SPEC_FILE} (${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`);
  }
}
