import { z, type ZodType } from "zod";

/**
 * Strict-schema lint (BORROW-01, #89). A provider in strict structured-output mode
 * (Groq / OpenRouter, and Anthropic tool-calling) requires EVERY property to appear in
 * `required`; an optional key is dropped from `required` and causes intermittent
 * schema-parse failures across providers.
 *
 * We assert the property over the *generated* JSON Schema — zod 4's native
 * {@link z.toJSONSchema}, the exact shape LangChain hands the provider — rather than by
 * Zod-AST introspection. That way `.optional()` / `.nullish()` are rejected (they fall out
 * of `required`), while `.nullable()` and `.default(...)` — the sanctioned replacements
 * called out in the DoD — stay in `required` and pass.
 */

type Json = { [k: string]: unknown };

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Walk a JSON-Schema tree; collect breadcrumb paths of properties missing from `required`. */
function walk(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, `${path}[${i}]`, out));
    return;
  }
  if (!isObj(node)) return;

  if (isObj(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const key of Object.keys(node.properties)) {
      if (!required.has(key)) out.push(path ? `${path}.${key}` : key);
    }
  }
  // Recurse into every child schema node (properties, items, $defs, anyOf/allOf/oneOf, …).
  for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}/${k}` : k, out);
}

/**
 * Lint one structured-output schema. Returns the breadcrumb paths of every property that
 * is NOT in its object's `required` set (empty array ⇒ provider-safe). Pure.
 */
export function lintZodSchema(schema: ZodType, name = "schema"): string[] {
  const out: string[] = [];
  walk(z.toJSONSchema(schema) as unknown, name, out);
  return out;
}

/** Throw if a schema is not provider-safe (any property missing from `required`). */
export function assertStrictSchema(schema: ZodType, name = "schema"): void {
  const violations = lintZodSchema(schema, name);
  if (violations.length > 0) {
    throw new Error(
      `Schema "${name}" is not provider-safe for strict structured output — ` +
        `these keys are not in \`required\`: ${violations.join(", ")}. ` +
        `Use .nullable() or .default(...) instead of .optional() (#89, BORROW-01).`,
    );
  }
}
