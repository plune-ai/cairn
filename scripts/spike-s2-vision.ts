/**
 * Spike S2 — vision + structured output (ЖИВИЙ; потрібен ключ vision-провайдера).
 * Доводить: обрана vision-модель приймає наш imageBlock і повертає валідний structured JSON.
 *   Запуск: npm run spike:s2-vision   (профіль із vision-моделлю, напр. anthropic або mixed)
 */
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { cfg, keysOf, SAMPLE_PNG_B64 } from "./_shared.js";
import { makeModel, imageBlock } from "../src/llm/index.js";

const c = cfg();
const visionTier = c.models.vision ?? c.models.reasoning;
if (!visionTier.supportsVision) {
  console.error(
    `Tier для зображення (${visionTier.model}) не підтримує vision. Перемкни LLM_PROFILE на anthropic/mixed або задай vision-модель.`,
  );
  process.exit(1);
}

const schema = z.object({
  description: z.string(),
  approxColors: z.array(z.string()),
});

const model = makeModel(visionTier, keysOf(c));
const structured = model.withStructuredOutput(schema);

const msg = new HumanMessage({
  content: [
    { type: "text", text: "Опиши це зображення у структурованому вигляді." },
    imageBlock(SAMPLE_PNG_B64, "image/png"),
  ],
});

const res = await structured.invoke([msg]);
console.log(`S2 OK — vision-модель '${visionTier.provider}/${visionTier.model}' повернула structured JSON:`);
console.log(JSON.stringify(res, null, 2));
