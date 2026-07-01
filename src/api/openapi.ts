/**
 * C1-04 / API-1 (#22) — OpenAPI ingest into Cairn's internal endpoint model.
 *
 * This is the FIRST vertical slice of the `api` modality: it only *reads* an OpenAPI v3 spec
 * (JSON or YAML, from a file path or a URL) and flattens it into a small, generation-ready model
 * (one entry per method × path). Case generation, the runner, the report and the Plune-record write
 * are later slices (API-2 #137 / API-3 #138) — nothing here generates or executes anything.
 *
 * Parsing, YAML support, `$ref` resolution (incl. circular refs) and 3.0/3.1 handling are delegated
 * to the maintained `@apidevtools/swagger-parser` (lazy-loaded so it stays off every non-api path).
 */

/** One parameter of an endpoint (query/path/header/cookie). */
export interface ApiParam {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required: boolean;
  /** Dereferenced JSON schema for the parameter value (may be absent). */
  schema?: unknown;
}

/** One response of an endpoint, keyed by status code (or "default"). */
export interface ApiResponse {
  status: string;
  description?: string;
  /** Schema of the first response media type, if the response carries a body. */
  schema?: unknown;
}

/** The request body of an endpoint (absent for GET/DELETE-style ops without a body). */
export interface ApiRequestBody {
  required: boolean;
  mediaTypes: string[];
  /** Schema of the first request media type, if any. */
  schema?: unknown;
}

/** One operation: a single HTTP method on a single path. */
export interface ApiEndpoint {
  /** Upper-case HTTP method, e.g. "GET", "POST". */
  method: string;
  /** Templated path, e.g. "/users/{id}". */
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  parameters: ApiParam[];
  requestBody?: ApiRequestBody;
  responses: ApiResponse[];
  /** Names of the security schemes this op requires (operation-level, else the spec default). */
  security: string[];
  /** The spec's own `deprecated:` flag (API-6, #136) — surfaced, not filtered: still worth a coverage row. */
  deprecated: boolean;
}

/** The flattened spec: everything a later slice (API-2) needs to design + run cases. */
export interface ApiModel {
  title?: string;
  /** info.version of the described API (not the OpenAPI version). */
  version?: string;
  /** The `openapi:` field, e.g. "3.0.3" / "3.1.0". */
  openapiVersion: string;
  endpoints: ApiEndpoint[];
  /** Distinct tags across all endpoints, sorted. */
  tags: string[];
  /** Names declared under components.securitySchemes. */
  securitySchemes: string[];
}

/** Minimal structural view of a dereferenced OpenAPI 3.x document (we read it loosely). */
interface RawDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, RawPathItem | undefined>;
  components?: { securitySchemes?: Record<string, unknown> };
  security?: RawSecurityRequirement[];
}
interface RawPathItem {
  parameters?: RawParam[];
  [method: string]: unknown;
}
interface RawOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: RawParam[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
  security?: RawSecurityRequirement[];
  deprecated?: boolean;
}
interface RawParam {
  name: string;
  in: string;
  required?: boolean;
  schema?: unknown;
}
type RawSecurityRequirement = Record<string, string[]>;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/**
 * Read an OpenAPI 3.x spec (JSON or YAML; file path or URL) and flatten it into an {@link ApiModel}.
 *
 * Throws a single, message-clear `Error` on anything we can't use — unreadable/invalid spec,
 * unresolvable `$ref`, or an unsupported version (Swagger 2.0 / non-3.x) — so the command can report
 * it instead of crashing.
 */
export async function ingestOpenApi(spec: string): Promise<ApiModel> {
  // Lazy: keep swagger-parser (and its YAML/ref-resolver deps) off every non-`api` code path.
  const { default: SwaggerParser } = await import("@apidevtools/swagger-parser");

  let doc: RawDoc;
  try {
    // dereference = parse (JSON/YAML, file/URL) + resolve every $ref (circular refs become object
    // cycles rather than throwing), so the walk below sees concrete params/schemas.
    doc = (await SwaggerParser.dereference(spec)) as unknown as RawDoc;
  } catch (e) {
    throw new Error(`Could not read OpenAPI spec "${spec}": ${(e as Error).message}`);
  }

  const version = doc.openapi;
  if (!version || !/^3\./.test(version)) {
    throw new Error(
      doc.swagger
        ? `Unsupported spec: Swagger/OpenAPI 2.0 ("swagger: ${doc.swagger}") — provide an OpenAPI 3.x spec.`
        : `Unsupported spec: expected an "openapi: 3.x" document (got ${version ? `"${version}"` : "no openapi/swagger field"}).`,
    );
  }

  const endpoints: ApiEndpoint[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item) continue;
    const pathParams = item.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method] as RawOperation | undefined;
      if (!op || typeof op !== "object") continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary,
        tags: op.tags ?? [],
        parameters: mergeParams(pathParams, op.parameters ?? []).map(toApiParam),
        requestBody: toRequestBody(op.requestBody),
        responses: toResponses(op.responses),
        // Operation security overrides the spec default; [] means "explicitly public".
        security: securityNames(op.security ?? doc.security ?? []),
        deprecated: op.deprecated ?? false,
      });
    }
  }

  const tags = [...new Set(endpoints.flatMap((e) => e.tags))].sort();
  const securitySchemes = Object.keys(doc.components?.securitySchemes ?? {});

  return {
    title: doc.info?.title,
    version: doc.info?.version,
    openapiVersion: version,
    endpoints,
    tags,
    securitySchemes,
  };
}

/** Merge path-level params with operation params; an op param overrides a path param of same (name,in). */
function mergeParams(pathParams: RawParam[], opParams: RawParam[]): RawParam[] {
  const byKey = new Map<string, RawParam>();
  for (const p of pathParams) byKey.set(`${p.in}:${p.name}`, p);
  for (const p of opParams) byKey.set(`${p.in}:${p.name}`, p);
  return [...byKey.values()];
}

function toApiParam(p: RawParam): ApiParam {
  const where: ApiParam["in"] =
    p.in === "query" || p.in === "path" || p.in === "header" || p.in === "cookie" ? p.in : "query";
  return { name: p.name, in: where, required: p.required ?? where === "path", schema: p.schema };
}

function toRequestBody(rb: RawOperation["requestBody"]): ApiRequestBody | undefined {
  if (!rb) return undefined;
  const content = rb.content ?? {};
  const mediaTypes = Object.keys(content);
  const first = mediaTypes[0];
  return { required: rb.required ?? false, mediaTypes, schema: first ? content[first]?.schema : undefined };
}

function toResponses(responses: RawOperation["responses"]): ApiResponse[] {
  return Object.entries(responses ?? {}).map(([status, r]) => {
    const first = Object.keys(r.content ?? {})[0];
    return {
      status,
      description: r.description,
      schema: first ? r.content?.[first]?.schema : undefined,
    };
  });
}

/** Flatten security requirement objects to the distinct set of scheme names they reference. */
function securityNames(reqs: RawSecurityRequirement[]): string[] {
  return [...new Set(reqs.flatMap((r) => Object.keys(r)))];
}
