/**
 * Spike S1 — zod ↔ withStructuredOutput (БЕЗ мережі).
 * Доводить, що біндинг типізується й конструюється на встановленій версії zod (4.x) з langchain 1.x.
 * Це дублює юніт-тест (tests/unit/llm.test.ts), але як окремий operator-скрипт для звіту.
 *   Запуск: npm run spike:s1-zod
 */
import { z } from "zod";
import { makeModel } from "../src/llm/index.js";

const schema = z.object({ ok: z.boolean(), items: z.array(z.string()) });
const model = makeModel(
  { provider: "anthropic", model: "claude-opus-4-8", supportsVision: true },
  { anthropicApiKey: "dummy-key-no-network" },
);
const structured = model.withStructuredOutput(schema);

console.log("S1 OK — zod біндиться з withStructuredOutput (langchain 1.x), без мережі.");
console.log("typeof structured:", typeof structured);
