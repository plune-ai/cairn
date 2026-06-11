/**
 * Spike S6 — structured output parity Anthropic vs OpenRouter (LIVE; requires keys).
 * Proves/measures: whether DeepSeek/Qwen via OpenRouter adhere to the JSON schema as well as Anthropic.
 *   Run: npm run spike:s6-parity
 */
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { cfg, keysOf } from "./_shared.js";
import { makeModel } from "../src/llm/index.js";
import type { ModelTier } from "../src/config/index.js";

const c = cfg();
const keys = keysOf(c);
if (!keys.anthropicApiKey && !keys.openrouterApiKey) {
  console.error("No API key found (ANTHROPIC_API_KEY / OPENROUTER_API_KEY).");
  process.exit(1);
}

const schema = z.object({
  title: z.string(),
  steps: z.array(z.string()),
  priority: z.enum(["low", "medium", "high"]),
});
const prompt = "Generate one UI test case for a login form in a structured form.";

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
console.log("S6 — compare the validity/structure of output across providers; record in the spike report.");
