/**
 * #228 — `cairn api --spec` reads a Postman collection (v2.x) or a HAR file as well as an OpenAPI spec.
 *
 * The format is told from the content ({@link detectSpecFormat}). A collection or a HAR is turned into an OpenAPI 3.x
 * document by `derived.ts` (operations and schemas marked `x-cairn-derived: true`) and goes on from there exactly as a
 * written spec does; an OpenAPI spec is not touched here at all.
 *
 * A HAR holds tokens and cookies in clear text. Header values, query values and bodies never enter the document (only
 * names, types and status codes), and the values that look secret are collected so the writer scrubs them too.
 */
import {
  DerivedSpecBuilder,
  DERIVED_KEY,
  bodyFields,
  exchangeSecrets,
  isApiTraffic,
  isJsonMedia,
  mediaType,
  type Exchange,
} from "./derived.js";

export type SpecFormat = "openapi" | "postman" | "har";

/** What a collection or a HAR became: the document, the secrets to scrub from it, and what was left out. */
export interface DerivedSpec {
  format: Exclude<SpecFormat, "openapi">;
  doc: Record<string, unknown>;
  secrets: string[];
  /** One line each, for the run's output: `3 static files left out`. */
  notes: string[];
  /** How many requests went into the document. */
  requests: number;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `postman` for a collection (`info.schema` on getpostman.com, or `info` + `item`), `har` for `log.entries`; anything
 * else — YAML, an OpenAPI or Swagger document, text that is not JSON — is `openapi`, read as before. */
export function detectSpecFormat(text: string): SpecFormat {
  const v = parse(text);
  if (!isObject(v) || "openapi" in v || "swagger" in v) return "openapi";
  if (isObject(v.log) && Array.isArray(v.log.entries)) return "har";
  const info = v.info;
  if (isObject(info) && (/getpostman\.com|postman/i.test(String(info.schema ?? "")) || Array.isArray(v.item))) return "postman";
  if (Array.isArray(v.requests) && typeof v.name === "string") return "postman"; // v1: refused with a message below
  return "openapi";
}

/** The derived spec for a Postman collection or a HAR; `undefined` for anything else (an OpenAPI spec goes on as is). */
export function deriveSpec(text: string): DerivedSpec | undefined {
  const format = detectSpecFormat(text);
  if (format === "openapi") return undefined;
  const v = parse(text) as Record<string, unknown>;
  return format === "har" ? fromHar(v) : fromPostman(v);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// Postman

interface PmKV {
  key?: string;
  value?: unknown;
  disabled?: boolean;
}
interface PmUrl {
  raw?: string;
  path?: string[] | string;
  query?: PmKV[];
  variable?: PmKV[];
}
interface PmRequest {
  method?: string;
  header?: PmKV[] | string;
  url?: PmUrl | string;
  body?: { mode?: string; raw?: string; urlencoded?: PmKV[]; formdata?: PmKV[]; options?: { raw?: { language?: string } } };
  auth?: unknown;
  description?: unknown;
}
interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: PmRequest | string;
  response?: { code?: number; header?: PmKV[] | string; body?: string; originalRequest?: PmRequest }[];
  auth?: unknown;
}

const kvs = (list: unknown): [string, string][] =>
  Array.isArray(list)
    ? (list as PmKV[]).filter((p) => p && typeof p.key === "string" && !p.disabled).map((p) => [p.key!, String(p.value ?? "")])
    : [];

/** Every string under an `auth` block (`bearer: [{ key: "token", value: "…" }]`) as `name: value` pairs. */
function authFields(auth: unknown): [string, string][] {
  if (!isObject(auth)) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(auth)) {
    if (k === "type") continue;
    if (Array.isArray(v)) for (const [key, value] of kvs(v)) out.push([`${k} ${key}`, value]);
    else if (typeof v === "string") out.push([k, v]);
  }
  return out;
}

/** The path of a Postman URL, its host (`{{baseUrl}}`, `https://api.example.test`) taken off: `/projects/:id`. */
function postmanPath(url: PmUrl | string | undefined): { path: string; query: string[]; host?: string } {
  const raw = typeof url === "string" ? url : (url?.raw ?? "");
  const [beforeQuery = "", query = ""] = raw.split("?", 2);
  const host = /^(https?:\/\/[^/{}]+)/i.exec(beforeQuery)?.[1];
  let path: string;
  if (typeof url === "object" && url.path !== undefined) {
    path = `/${(Array.isArray(url.path) ? url.path : String(url.path).split("/")).filter((s) => s !== "").join("/")}`;
  } else {
    path = beforeQuery.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, "").replace(/^\{\{[^}]*\}\}/, "");
    if (!path.startsWith("/")) path = `/${path.replace(/^[^/]*\/?/, "")}`; // `api.example.test/x` (no scheme) → `/x`
  }
  const keys =
    typeof url === "object" && Array.isArray(url.query)
      ? kvs(url.query).map(([k]) => k)
      : query
          .split("&")
          .map((p) => decodeURIComponent(p.split("=")[0] ?? ""))
          .filter(Boolean);
  return { path, query: keys, ...(host ? { host } : {}) };
}

const headerOf = (list: PmKV[] | string | undefined, name: string): string | undefined =>
  Array.isArray(list) ? kvs(list).find(([k]) => k.toLowerCase() === name)?.[1] : undefined;

/** A request body as a value to read the shape of: parsed JSON, the keys of a form, or nothing. */
function postmanBody(body: PmRequest["body"], header: PmKV[] | string | undefined): Exchange["request"] {
  if (!body?.mode) return undefined;
  if (body.mode === "urlencoded" || body.mode === "formdata") {
    const fields = kvs(body.mode === "urlencoded" ? body.urlencoded : body.formdata);
    return {
      contentType: body.mode === "urlencoded" ? "application/x-www-form-urlencoded" : "multipart/form-data",
      body: Object.fromEntries(fields.map(([k]) => [k, ""])),
    };
  }
  if (body.mode === "raw" && body.raw && body.raw.trim() !== "") {
    const declared = mediaType(headerOf(header, "content-type"));
    const json = body.options?.raw?.language === "json" || isJsonMedia(declared);
    const parsed = parse(body.raw);
    if (json || parsed !== undefined) return { contentType: declared ?? "application/json", body: parsed };
    return { contentType: declared ?? "text/plain" };
  }
  return undefined;
}

function fromPostman(c: Record<string, unknown>): DerivedSpec {
  if (Array.isArray(c.requests)) {
    throw new Error("Postman collection v1 is not supported: export the collection as v2.1 (Collection → Export → v2.1).");
  }
  const info = (c.info ?? {}) as Record<string, unknown>;
  const builder = new DerivedSpecBuilder();
  const headers: [string, string][] = [];
  const fields: [string, string][] = [...kvs(c.variable), ...authFields(c.auth)];
  const hosts = new Map<string, number>();
  let requests = 0;
  let skipped = 0;

  const walk = (items: PmItem[] | undefined, tags: string[]): void => {
    for (const it of items ?? []) {
      if (!it || typeof it !== "object") continue;
      if (Array.isArray(it.item)) {
        fields.push(...authFields(it.auth));
        walk(it.item, it.name ? [...tags, it.name] : tags);
        continue;
      }
      const req: PmRequest | undefined = typeof it.request === "string" ? { url: it.request, method: "GET" } : it.request;
      if (!req) {
        skipped += 1;
        continue;
      }
      const { path, query, host } = postmanPath(req.url);
      if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
      if (Array.isArray(req.header)) headers.push(...kvs(req.header));
      if (typeof req.url === "object") fields.push(...kvs(req.url.query), ...kvs(req.url.variable));
      fields.push(...authFields(req.auth), ...kvs(req.body?.urlencoded), ...kvs(req.body?.formdata));
      const request = postmanBody(req.body, req.header);
      if (request?.body !== undefined) fields.push(...bodyFields(request.body));
      if (req.body?.mode === "raw" && request?.body === undefined && req.body.raw) fields.push(["body", req.body.raw]);
      const method = (req.method ?? "GET").toUpperCase();
      const base = { method, path, queryKeys: query, ...(it.name ? { summary: it.name } : {}), tags, ...(request ? { request } : {}) };
      const examples = (Array.isArray(it.response) ? it.response : []).filter((r) => !!r && typeof r.code === "number");
      requests += 1;
      if (examples.length === 0) builder.add(base);
      for (const r of examples) {
        if (Array.isArray(r.header)) headers.push(...kvs(r.header));
        const contentType = headerOf(r.header, "content-type");
        const parsed = r.body ? parse(r.body) : undefined;
        if (parsed !== undefined) fields.push(...bodyFields(parsed));
        const json = parsed !== undefined && (isJsonMedia(mediaType(contentType)) || contentType === undefined);
        builder.add({
          ...base,
          status: r.code,
          ...(json ? { response: { contentType: contentType ?? "application/json", body: parsed } } : {}),
        });
      }
    }
  };
  walk(c.item as PmItem[] | undefined, []);

  const servers = hosts.size === 1 ? [...hosts.keys()] : [];
  const notes = [`${plural(requests, "request")} from the collection → ${plural(builder.size, "operation")}`];
  if (skipped) notes.push(`${plural(skipped, "item")} without a request left out`);
  return {
    format: "postman",
    doc: builder.toOpenApi(
      {
        title: typeof info.name === "string" && info.name ? info.name : "Postman collection",
        description: `Derived from a Postman collection: what is marked ${DERIVED_KEY} was inferred from its requests and examples, not described by a schema.`,
      },
      servers,
    ),
    secrets: exchangeSecrets({ headers, fields }),
    notes,
    requests,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// HAR

interface HarNV {
  name?: string;
  value?: string;
}
interface HarEntry {
  _resourceType?: string;
  request?: { method?: string; url?: string; headers?: HarNV[]; queryString?: HarNV[]; cookies?: HarNV[]; postData?: { mimeType?: string; text?: string; params?: HarNV[] } };
  response?: { status?: number; headers?: HarNV[]; cookies?: HarNV[]; content?: { mimeType?: string; text?: string; encoding?: string } };
}

const nvs = (list: HarNV[] | undefined): [string, string][] =>
  Array.isArray(list) ? list.filter((p) => p && typeof p.name === "string").map((p) => [p.name!, String(p.value ?? "")]) : [];

function responseText(c: NonNullable<HarEntry["response"]>["content"]): string | undefined {
  if (!c?.text) return undefined;
  if (c.encoding === "base64") {
    try {
      return Buffer.from(c.text, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return c.text;
}

/**
 * The API requests of a HAR: pages, scripts, styles, images and fonts are left out, and so is every origin but the
 * one most of the API requests went to (analytics, a CDN, a sign-in provider are not this API).
 */
function fromHar(h: Record<string, unknown>): DerivedSpec {
  type Entry = HarEntry & { request: NonNullable<HarEntry["request"]> & { url: string } };
  const entries = ((h.log as Record<string, unknown>).entries as HarEntry[]).filter(
    (e): e is Entry => !!e && typeof e === "object" && typeof e.request?.url === "string",
  );
  const urlOf = (e: Entry): URL | undefined => {
    try {
      return new URL(e.request.url);
    } catch {
      return undefined;
    }
  };
  const api = entries.filter((e) => {
    const u = urlOf(e);
    return (
      u !== undefined &&
      /^https?:$/.test(u.protocol) &&
      isApiTraffic({ url: e.request.url, resourceType: e._resourceType, mimeType: e.response?.content?.mimeType })
    );
  });
  const origins = new Map<string, number>();
  for (const e of api) origins.set(urlOf(e)!.origin, (origins.get(urlOf(e)!.origin) ?? 0) + 1);
  const origin = [...origins].sort((a, b) => b[1] - a[1])[0]?.[0];

  const builder = new DerivedSpecBuilder();
  const headers: [string, string][] = [];
  const fields: [string, string][] = [];
  let used = 0;
  for (const e of entries) {
    // Every entry's credentials are scrubbed, also those of the requests left out of the document.
    headers.push(...nvs(e.request.headers), ...nvs(e.response?.headers));
    fields.push(...nvs(e.request.cookies), ...nvs(e.response?.cookies), ...nvs(e.request.queryString), ...nvs(e.request.postData?.params));
    const u = urlOf(e);
    if (u) for (const [k, v] of u.searchParams) fields.push([k, v]);
    if (u?.password) fields.push(["password", decodeURIComponent(u.password)]);
  }
  for (const e of api) {
    const u = urlOf(e)!;
    if (u.origin !== origin) continue;
    used += 1;
    const post = e.request.postData;
    const reqType = mediaType(post?.mimeType ?? nvs(e.request.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1]);
    let request: Exchange["request"];
    if (post && (post.text || post.params?.length)) {
      if (reqType === "application/x-www-form-urlencoded" || reqType === "multipart/form-data" || (!post.text && post.params)) {
        request = { contentType: reqType ?? "application/x-www-form-urlencoded", body: Object.fromEntries(nvs(post.params).map(([k]) => [k, ""])) };
        if (post.text && reqType === "application/x-www-form-urlencoded") {
          const form = new URLSearchParams(post.text);
          for (const [k, v] of form) fields.push([k, v]);
          request.body = Object.fromEntries([...form.keys()].map((k) => [k, ""]));
        }
      } else {
        const parsed = post.text ? parse(post.text) : undefined;
        if (parsed !== undefined) fields.push(...bodyFields(parsed));
        else if (post.text) fields.push(["body", post.text]);
        request = { contentType: reqType ?? (parsed !== undefined ? "application/json" : "text/plain"), ...(parsed !== undefined ? { body: parsed } : {}) };
      }
    }
    const resType = mediaType(e.response?.content?.mimeType);
    const text = responseText(e.response?.content);
    const parsed = text && isJsonMedia(resType) ? parse(text) : undefined;
    if (parsed !== undefined) fields.push(...bodyFields(parsed));
    const status = e.response?.status;
    builder.add({
      method: (e.request.method ?? "GET").toUpperCase(),
      path: u.pathname,
      queryKeys: [...new Set([...u.searchParams.keys()])],
      ...(status ? { status } : {}),
      ...(request ? { request } : {}),
      ...(parsed !== undefined ? { response: { contentType: resType, body: parsed } } : {}),
    });
  }

  const notes = [`${plural(used, "request")} from the HAR → ${plural(builder.size, "operation")}${origin ? ` on ${origin}` : ""}`];
  const statics = entries.length - api.length;
  if (statics) notes.push(`${plural(statics, "page or static file")} (scripts, styles, images, fonts) left out`);
  const others = api.length - used;
  if (others) notes.push(`${plural(others, "request")} to another origin left out`);
  return {
    format: "har",
    doc: builder.toOpenApi(
      {
        title: origin ? `${new URL(origin).host} (from a HAR)` : "HAR traffic",
        description: `Derived from a HAR file: what is marked ${DERIVED_KEY} was inferred from the recorded requests and responses, not described by a schema.`,
      },
      origin ? [origin] : [],
    ),
    secrets: exchangeSecrets({ headers, fields }),
    notes,
    requests: used,
  };
}
