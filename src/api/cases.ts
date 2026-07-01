/**
 * C1-04 / API-2 (#132) — baseline happy-path case generation from the {@link ApiModel} (API-1).
 *
 * One nominal case per operation: required params + a request body synthesised straight from the
 * (already-dereferenced) JSON schema, paired with the operation's declared success response.
 *
 * No LLM here — and that is the point. Happy-path values follow mechanically from the schema
 * (`example` → `default` → `enum` → type), so synthesis is pure and deterministic (same spec → same
 * cases). The provider abstraction (`StructuredInvoke`) stays available for later, fuzzier slices
 * (negative / boundary cases, API-3+); the DoD's "any LLM use is mockable" holds vacuously because
 * this slice uses none. No runner either — that is API-3.
 *
 * API-5 (#135): every case also carries a `technique` + `rationale` — the same ISO/IEC/IEEE 29119-4
 * methodology tagging web cases carry (`design/schema.ts`) — so the emitted ATC artifact states WHY
 * the case exists, not just what it sends.
 */
import type { z } from "zod";
import type { TestTechniqueSchema, TestTypeSchema } from "../design/schema.js";
import type { ApiEndpoint, ApiLink, ApiModel, ApiParam } from "./openapi.js";

/** ISO/IEC/IEEE 29119-4 technique — shared enum with web cases (`design/schema.ts`). */
export type ApiCaseTechnique = z.infer<typeof TestTechniqueSchema>;

/** Positive (valid path) | Negative (invalid/erroneous) — shared enum with web cases (API-8, #145). */
export type ApiCaseType = z.infer<typeof TestTypeSchema>;

/**
 * The stable key an operation is identified by across the model/cases/results/coverage — same rule
 * everywhere (API-6, #136): `operationId` if declared, else `METHOD path`.
 */
export function apiEndpointKey(e: { method: string; path: string; operationId?: string }): string {
  return e.operationId ?? `${e.method} ${e.path}`;
}

/** Values synthesised for an operation's parameters, grouped by location. */
export interface ApiCaseParams {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  header: Record<string, unknown>;
  cookie: Record<string, unknown>;
}

/** One generated happy-path case: what to send, and the success response to expect. */
export interface ApiCase {
  /** `operationId` if present, else `METHOD path` — stable per operation. */
  name: string;
  method: string;
  path: string;
  operationId?: string;
  /** Required params with schema-synthesised values (optional params are omitted — nominal path). */
  params: ApiCaseParams;
  /** Request body synthesised from the body schema, if the operation declares one. */
  body?: unknown;
  /** Declared success status this case expects ("200"/"201"/"204"/"default"…). */
  expectedStatus: string;
  /** Schema of the expected success body, if that response carries one. */
  expectedSchema?: unknown;
  /** Positive (happy-path) | Negative (contract-violating) — API-8 (#145) distinct case category. */
  type: ApiCaseType;
  /** ISO/IEC/IEEE 29119-4 technique this case embodies (API-5 methodology tagging). */
  technique: ApiCaseTechnique;
  /** Why this case exists / what it covers — the coverage rationale (API-5). */
  rationale: string;
  /** Declared `links` on this case's success response (API-9, #146), if the spec has any. A scenario
   * runner (`scenario-runner.ts`) prefers these over its same-name-field capture heuristic. */
  responseLinks?: Record<string, ApiLink>;
  /** The media type `body` was synthesised from (API-10, #150) — the operation's first declared
   * `requestBody.mediaTypes` entry. The runner encodes as `multipart/form-data` when this says so,
   * JSON otherwise (including when the operation declares no body at all). */
  bodyMediaType?: string;
  /** Which adversarial style (BORROW-07, #95) generated this case, if any. */
  adversarialStyle?: "normal" | "curious" | "psycho" | "hacker";
  /** OWASP WSTG test ID this case exercises (BORROW-07, #95), when one specifically applies. */
  wstgId?: string;
  /** Send this request with auth headers stripped (BORROW-07, #95 `hacker` style) — the runner skips
   * merging `RunnerOptions.auth.headers` when true, instead of the normal always-applied behaviour. */
  stripAuth?: boolean;
}

/** Generate one baseline happy-path case per operation, in the model's (deterministic) order. */
export function generateApiCases(model: ApiModel): ApiCase[] {
  return model.endpoints.map(toCase);
}

/**
 * C1-04 / API-8 (#145) — one negative-schema case per operation that has a request contract worth
 * violating: corrupt a request-body property to the wrong JSON type, or (bodyless operations) omit a
 * required non-path parameter. An operation with neither (e.g. `GET /health`) has nothing to violate
 * and is skipped — a forced violation would just be noise, not a contract check.
 */
export function generateNegativeCases(model: ApiModel): ApiCase[] {
  return model.endpoints.map(toNegativeCase).filter((c): c is ApiCase => c !== undefined);
}

/** Required params (as sent for the nominal happy path), optionally dropping one to violate it. */
function synthRequiredParams(e: ApiEndpoint, omit?: ApiParam): ApiCaseParams {
  const params: ApiCaseParams = { path: {}, query: {}, header: {}, cookie: {} };
  for (const p of e.parameters) {
    if (!p.required) continue;
    if (omit && p.in === omit.in && p.name === omit.name) continue;
    params[p.in][p.name] = synth(p.schema);
  }
  return params;
}

/** ALL params (required AND optional) with schema-synthesised values — the "curious" adversarial
 * style's full-coverage variant of `synthRequiredParams` (BORROW-07, #95): optional params get
 * exercised too, instead of the happy path's omit-if-optional convention. */
export function synthAllParams(e: ApiEndpoint): ApiCaseParams {
  const params: ApiCaseParams = { path: {}, query: {}, header: {}, cookie: {} };
  for (const p of e.parameters) params[p.in][p.name] = synth(p.schema);
  return params;
}

/** Body-schema properties that declare an `enum` with more than one value — the "curious" style's
 * one-case-per-additional-value expansion needs the full list (the happy path's `synth()` only ever
 * sends the first). */
export function enumProps(schema: unknown): [string, unknown[]][] {
  if (!schema || typeof schema !== "object") return [];
  const out: [string, unknown[]][] = [];
  for (const [name, sub] of Object.entries((schema as Schema).properties ?? {})) {
    if (sub.enum && sub.enum.length > 1) out.push([name, sub.enum]);
  }
  return out;
}

/** Build the happy-path case for one operation (API-9, #146: also reused by `scenarios.ts` per step —
 * a scenario step is a normal case whose path params get overwritten with captured values at run time). */
export function toCase(e: ApiEndpoint): ApiCase {
  const success = pickSuccess(e);
  const expectedStatus = success?.status ?? "200";
  return {
    name: apiEndpointKey(e),
    method: e.method,
    path: e.path,
    operationId: e.operationId,
    params: synthRequiredParams(e),
    body: e.requestBody?.schema !== undefined ? synth(e.requestBody.schema) : undefined,
    expectedStatus,
    expectedSchema: success?.schema,
    ...(success?.links ? { responseLinks: success.links } : {}),
    ...(e.requestBody?.mediaTypes[0] !== undefined ? { bodyMediaType: e.requestBody.mediaTypes[0] } : {}),
    type: "Positive",
    // Nominal happy-path = the valid equivalence class for this operation's inputs (ISO 29119-4).
    technique: "equivalence-partitioning",
    rationale:
      `Happy-path case in the valid equivalence class for ${e.method} ${e.path}: exercises the ` +
      `required parameters/body with schema-valid values and asserts the declared success response ` +
      `(${expectedStatus}).`,
  };
}

/** Body-schema properties whose declared (primitive) type we can flip to something invalid — reused
 * by the "psycho"/"hacker" adversarial styles (BORROW-07, #95) to target a string/numeric property. */
export function corruptibleProps(schema: unknown): [string, string][] {
  if (!schema || typeof schema !== "object") return [];
  const out: [string, string][] = [];
  for (const [name, sub] of Object.entries((schema as Schema).properties ?? {})) {
    const type = Array.isArray(sub.type) ? sub.type.find((t) => t !== "null") : sub.type;
    if (typeof type === "string") out.push([name, type]);
  }
  return out;
}

/** A JSON value of a different type than `type` — always a contract violation for that property. */
function wrongTypeValue(type: string): unknown {
  switch (type) {
    case "string":
      return 42;
    case "integer":
    case "number":
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    default:
      return "not-a-valid-value"; // array/object/other
  }
}

/** The lowest declared 4xx status, else the generic "4XX" range (matched by the runner's `statusMatches`).
 * Reused by the "psycho"/"hacker" adversarial styles (BORROW-07, #95) — same "expect rejection"
 * convention as a negative case. */
export function pickErrorStatus(e: ApiEndpoint): string {
  const fourXX = e.responses.filter((r) => /^4\d\d$/.test(r.status)).sort((a, b) => a.status.localeCompare(b.status));
  return fourXX[0]?.status ?? "4XX";
}

/** The declared response schema for an EXACT status match, if the case picked one (not the "4XX" fallback). */
export function pickErrorSchema(e: ApiEndpoint, expectedStatus: string): unknown {
  return e.responses.find((r) => r.status === expectedStatus)?.schema;
}

function buildNegativeCase(e: ApiEndpoint, input: { body?: unknown; params: ApiCaseParams }, violation: string): ApiCase {
  const expectedStatus = pickErrorStatus(e);
  return {
    name: `${apiEndpointKey(e)} (negative)`,
    method: e.method,
    path: e.path,
    operationId: e.operationId,
    params: input.params,
    body: input.body,
    expectedStatus,
    expectedSchema: pickErrorSchema(e, expectedStatus),
    type: "Negative",
    // Deliberately-invalid input, chosen from experience of common contract violations (ISO 29119-4).
    technique: "error-guessing",
    rationale:
      `Negative-schema case for ${e.method} ${e.path}: ${violation}, expecting the API to reject the ` +
      `request (${expectedStatus}) rather than accept it.`,
  };
}

function toNegativeCase(e: ApiEndpoint): ApiCase | undefined {
  const bodySchema = e.requestBody?.schema as Schema | undefined;
  if (bodySchema) {
    const [prop] = corruptibleProps(bodySchema);
    if (prop) {
      const [name, type] = prop;
      const body = synth(bodySchema) as Record<string, unknown>;
      body[name] = wrongTypeValue(type);
      return buildNegativeCase(
        e,
        { body, params: synthRequiredParams(e) },
        `sends "${name}" as the wrong type in the request body (expected ${type})`,
      );
    }
  }

  const nonPathRequired = e.parameters.find((p) => p.required && p.in !== "path");
  if (nonPathRequired) {
    return buildNegativeCase(
      e,
      { params: synthRequiredParams(e, nonPathRequired) },
      `omits the required ${nonPathRequired.in} param "${nonPathRequired.name}"`,
    );
  }

  return undefined; // nothing in this operation's contract is worth violating
}

/** The declared success response: the lowest 2xx, else `default`, else the first declared. */
function pickSuccess(e: ApiEndpoint): ApiEndpoint["responses"][number] | undefined {
  const twoXX = e.responses.filter((r) => /^2\d\d$/.test(r.status)).sort((a, b) => a.status.localeCompare(b.status));
  return twoXX[0] ?? e.responses.find((r) => r.status === "default") ?? e.responses[0];
}

interface Schema {
  type?: string | string[];
  format?: string;
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
}

/**
 * Synthesise one valid value for a (dereferenced) JSON schema, respecting `example`/`default`/`enum`,
 * types, `required` and `format`. `seen` guards the object cycles swagger-parser leaves behind for
 * circular `$ref`s (e.g. `Pet.friends: Pet[]`) so recursion terminates.
 */
function synth(schema: unknown, seen: Set<object> = new Set()): unknown {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Schema;

  // Explicit values win, in spec-precedence order.
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum && s.enum.length) return s.enum[0];

  // Composition: allOf = merge all subschemas; one/anyOf = take the first branch.
  if (s.allOf?.length) return synth(mergeAllOf(s.allOf), seen);
  if (s.oneOf?.length) return synth(s.oneOf[0], seen);
  if (s.anyOf?.length) return synth(s.anyOf[0], seen);

  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;

  // Objects/arrays recurse — stop if we re-enter the same schema node (circular ref).
  if (type === "object" || s.properties) {
    if (seen.has(s)) return undefined;
    return synthObject(s, new Set(seen).add(s));
  }
  if (type === "array") {
    if (seen.has(s)) return [];
    return s.items ? [synth(s.items, new Set(seen).add(s))].filter((v) => v !== undefined) : [];
  }

  switch (type) {
    case "string":
      // `format: binary` (e.g. a multipart file field) needs real bytes, not the literal word "string".
      return s.format === "binary" ? synthBinary() : synthString(s.format);
    case "integer":
    case "number":
      return s.minimum ?? 0;
    case "boolean":
      return true;
    default:
      return undefined; // untyped/unknown schema → omit
  }
}

function synthObject(s: Schema, seen: Set<object>): Record<string, unknown> {
  const required = new Set(s.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(s.properties ?? {})) {
    const v = synth(sub, seen);
    if (v !== undefined) out[key] = v;
    // A required field whose schema we couldn't synthesise (e.g. circular) still has to be present.
    else if (required.has(key)) out[key] = null;
  }
  return out;
}

/** Shallow-merge `allOf` members into one object schema (enough for happy-path bodies). */
function mergeAllOf(parts: Schema[]): Schema {
  const merged: Schema = { type: "object", properties: {}, required: [] };
  for (const p of parts) {
    Object.assign(merged.properties!, p.properties ?? {});
    if (p.required) merged.required!.push(...p.required);
  }
  return merged;
}

/** A small in-memory placeholder for a `format: binary` property (API-10, #150) — real bytes so a
 * multipart file field has actual "file" content to send; the runner (`runner.ts`) recognises a
 * `Buffer` value and encodes it as a file part instead of a stringified form field. */
function synthBinary(): Buffer {
  return Buffer.from("cairn placeholder file content");
}

/** A format-appropriate sample string (valid for the common OpenAPI string formats). */
function synthString(format?: string): string {
  switch (format) {
    case "email":
      return "user@example.com";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "date":
      return "2024-01-01";
    case "date-time":
      return "2024-01-01T00:00:00Z";
    case "uri":
    case "url":
      return "https://example.com";
    case "hostname":
      return "example.com";
    case "ipv4":
      return "127.0.0.1";
    default:
      return "string";
  }
}
