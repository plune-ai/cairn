import "dotenv/config";
import { loadConfig } from "../src/config/index.js";

/** Конфіг із .env для спайк-скриптів. */
export function cfg() {
  return loadConfig(process.env);
}

export function keysOf(c: ReturnType<typeof cfg>) {
  return { anthropicApiKey: c.anthropicApiKey, openrouterApiKey: c.openrouterApiKey };
}

/**
 * 1×1 PNG. Достатньо, щоб довести vision-ПЛУМБІНГ (модель приймає content-блок зображення
 * і повертає structured output), а не розуміння реальної сторінки.
 */
export const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
