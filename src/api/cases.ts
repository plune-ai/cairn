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
import type { TestTechniqueSchema } from "../design/schema.js";
import type { ApiEndpoint, ApiModel } from "./openapi.js";

/** ISO/IEC/IEEE 29119-4 technique — shared enum with web cases (`design/schema.ts`). */
export type ApiCaseTechnique = z.infer<typeof TestTechniqueSchema>;

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
  /** ISO/IEC/IEEE 29119-4 technique this case embodies (API-5 methodology tagging). */
  technique: ApiCaseTechnique;
  /** Why this case exists / what it covers — the coverage rationale (API-5). */
  rationale: string;
}

/** Generate one baseline happy-path case per operation, in the model's (deterministic) order. */
export function generateApiCases(model: ApiModel): ApiCase[] {
  return model.endpoints.map(toCase);
}

function toCase(e: ApiEndpoint): ApiCase {
  const params: ApiCaseParams = { path: {}, query: {}, header: {}, cookie: {} };
  for (const p of e.parameters) {
    // Nominal happy-path: send the required params; leave optional ones unset.
    if (!p.required) continue;
    params[p.in][p.name] = synth(p.schema);
  }

  const success = pickSuccess(e);
  const expectedStatus = success?.status ?? "200";
  return {
    name: e.operationId ?? `${e.method} ${e.path}`,
    method: e.method,
    path: e.path,
    operationId: e.operationId,
    params,
    body: e.requestBody?.schema !== undefined ? synth(e.requestBody.schema) : undefined,
    expectedStatus,
    expectedSchema: success?.schema,
    // Nominal happy-path = the valid equivalence class for this operation's inputs (ISO 29119-4).
    technique: "equivalence-partitioning",
    rationale:
      `Happy-path case in the valid equivalence class for ${e.method} ${e.path}: exercises the ` +
      `required parameters/body with schema-valid values and asserts the declared success response ` +
      `(${expectedStatus}).`,
  };
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
      return synthString(s.format);
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
