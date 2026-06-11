/**
 * Spike S2 — vision + structured output (LIVE; requires a vision-provider key).
 * Proves: the selected vision model accepts our imageBlock and returns valid structured JSON.
 *   Run: npm run spike:s2-vision   (profile with a vision model, e.g. anthropic or mixed)
 */
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { cfg, keysOf, SAMPLE_PNG_B64 } from "./_shared.js";
import { makeModel, imageBlock } from "../src/llm/index.js";

const c = cfg();
const visionTier = c.models.vision ?? c.models.reasoning;
if (!visionTier.supportsVision) {
  console.error(
    `The image tier (${visionTier.model}) does not support vision. Switch LLM_PROFILE to anthropic/mixed or specify a vision model.`,
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
    { type: "text", text: "Describe this image in a structured form." },
    imageBlock(SAMPLE_PNG_B64, "image/png"),
  ],
});

const res = await structured.invoke([msg]);
console.log(`S2 OK — vision model '${visionTier.provider}/${visionTier.model}' returned structured JSON:`);
console.log(JSON.stringify(res, null, 2));
