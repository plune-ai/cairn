/**
 * Spike S1 — zod ↔ withStructuredOutput (NO network).
 * Proves that the binding is typed and constructed on the installed zod version (4.x) with langchain 1.x.
 * This duplicates the unit test (tests/unit/llm.test.ts) but as a standalone operator script for the report.
 *   Run: npm run spike:s1-zod
 */
import { z } from "zod";
import { makeModel } from "../src/llm/index.js";

const schema = z.object({ ok: z.boolean(), items: z.array(z.string()) });
const model = makeModel(
  { provider: "anthropic", model: "claude-opus-4-8", supportsVision: true },
  { anthropicApiKey: "dummy-key-no-network" },
);
const structured = model.withStructuredOutput(schema);

console.log("S1 OK — zod binds with withStructuredOutput (langchain 1.x), no network.");
console.log("typeof structured:", typeof structured);
