/**
 * Spike S6 — паритет structured output Anthropic vs OpenRouter (ЖИВИЙ; потрібні ключі).
 * Доводить/міряє: чи DeepSeek/Qwen через OpenRouter тримають JSON-схему так само, як Anthropic.
 *   Запуск: npm run spike:s6-parity
 */
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { cfg, keysOf } from "./_shared.js";
import { makeModel } from "../src/llm/index.js";
import type { ModelTier } from "../src/config/index.js";

const c = cfg();
const keys = keysOf(c);
if (!keys.anthropicApiKey && !keys.openrouterApiKey) {
  console.error("Немає жодного ключа (ANTHROPIC_API_KEY / OPENROUTER_API_KEY).");
  process.exit(1);
}

const schema = z.object({
  title: z.string(),
  steps: z.array(z.string()),
  priority: z.enum(["low", "medium", "high"]),
});
const prompt = "Згенеруй один UI тест-кейс для форми логіну у структурованому вигляді.";

async function tryTier(label: string, tier: ModelTier): Promise<void> {
  try {
    const model = makeModel(tier, keys);
    const res = await model.withStructuredOutput(schema).invoke([new HumanMessage(prompt)]);
    console.log(`[${label}] OK:`, JSON.stringify(res));
  } catch (e) {
    console.log(`[${label}] FAIL:`, (e as Error).message);
  }
}

if (keys.anthropicApiKey) {
  await tryTier("anthropic/sonnet", {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    supportsVision: false,
  });
}
if (keys.openrouterApiKey) {
  await tryTier("openrouter/deepseek-chat", {
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    supportsVision: false,
  });
  await tryTier("openrouter/qwen-2.5-72b", {
    provider: "openrouter",
    model: "qwen/qwen-2.5-72b-instruct",
    supportsVision: false,
  });
}
console.log("S6 — порівняй валідність/структуру виводу між провайдерами; занотуй у звіт спайку.");
