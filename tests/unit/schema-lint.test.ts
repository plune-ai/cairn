import { describe, it, expect } from "vitest";
import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintZodSchema, assertStrictSchema } from "../../src/llm/schema-lint.js";
import { GeneratedSuiteSchema } from "../../src/codegen/schema.js";
import { PageAnalysisSchema } from "../../src/analyze/index.js";
import { CritiqueResultSchema } from "../../src/design/critique.js";
import { SetupPlanSchema, StructuredPreconditionSchema } from "../../src/flow/setup.js";
import { DesignResultSchema, JourneyResultSchema } from "../../src/design/schema.js";
import { JudgeSchema, ChecklistCoverageSchema } from "../../src/eval/judge.js";
import { PilotSchema } from "../../src/eval/pilot.js";

/**
 * Authoritative registry: every schema that is handed to a structured-output invoke (#89).
 * The drift-guard test below fails if a `invoke(XxxSchema, …)` in src/ is missing from here.
 */
const STRUCTURED_SCHEMAS: Record<string, z.ZodType> = {
  GeneratedSuiteSchema,
  PageAnalysisSchema,
  CritiqueResultSchema,
  SetupPlanSchema,
  DesignResultSchema,
  JourneyResultSchema,
  JudgeSchema,
  ChecklistCoverageSchema,
  PilotSchema,
};

describe("schema-lint: lintZodSchema (BORROW-01 / #89)", () => {
  it("flags an .optional() key — it is dropped from `required`", () => {
    const S = z.object({ a: z.string(), bad: z.string().optional() });
    const v = lintZodSchema(S, "S");
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(",")).toContain("bad");
  });

  it("accepts .nullable() and .default(...) — the sanctioned replacements (stay in `required`)", () => {
    const S = z.object({
      n: z.string().nullable(),
      d: z.string().default("x"),
      e: z.enum(["a", "b"]).default("a"),
      arr: z.array(z.string()).default([]),
    });
    expect(lintZodSchema(S, "S")).toEqual([]);
  });

  it("catches an optional key nested inside an array of objects", () => {
    const S = z.object({ items: z.array(z.object({ a: z.string(), bad: z.number().optional() })) });
    const v = lintZodSchema(S, "S");
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(",")).toContain("bad");
  });

  it("assertStrictSchema throws on an optional key, passes on a strict one", () => {
    expect(() => assertStrictSchema(z.object({ x: z.string().optional() }), "X")).toThrow(/required/);
    expect(() => assertStrictSchema(z.object({ x: z.string() }), "X")).not.toThrow();
  });
});

describe("schema-lint: every structured-invoke schema is provider-safe (required == properties)", () => {
  for (const [name, schema] of Object.entries(STRUCTURED_SCHEMAS)) {
    it(`${name} has no optional keys`, () => {
      expect(lintZodSchema(schema, name)).toEqual([]);
    });
  }

  it("StructuredPreconditionSchema (the #89 fix) keeps entity/endpoint/method in `required`", () => {
    // Pre-fix these were .optional() and fell out of `required` → this asserts the fix holds.
    expect(lintZodSchema(StructuredPreconditionSchema, "StructuredPreconditionSchema")).toEqual([]);
  });
});

describe("schema-lint: registry covers every invoke(...Schema) in src/ (drift guard)", () => {
  it("no structured-invoke schema is missing from STRUCTURED_SCHEMAS", () => {
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    const files = readdirSync(srcDir, { recursive: true }) as string[];
    const used = new Set<string>();
    for (const rel of files) {
      if (!rel.endsWith(".ts")) continue;
      const text = readFileSync(join(srcDir, rel), "utf8");
      for (const m of text.matchAll(/\binvoke\(\s*([A-Za-z_]\w*Schema)\b/g)) used.add(m[1]);
    }
    expect(used.size, "scan should find at least one invoke(...Schema)").toBeGreaterThan(0);
    const covered = new Set(Object.keys(STRUCTURED_SCHEMAS));
    const missing = [...used].filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });
});
