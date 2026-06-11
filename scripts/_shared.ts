import "dotenv/config";
import { loadConfig } from "../src/config/index.js";

/** Config from .env for spike scripts. */
export function cfg() {
  return loadConfig(process.env);
}

export function keysOf(c: ReturnType<typeof cfg>) {
  return { anthropicApiKey: c.anthropicApiKey, openrouterApiKey: c.openrouterApiKey };
}

/**
 * 1×1 PNG. Sufficient to prove the vision PLUMBING (the model accepts an image content block
 * and returns structured output), not the understanding of a real page.
 */
export const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
