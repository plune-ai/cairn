import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Інтеграційні тести піднімають реальний Chromium — потрібні щедріші таймаути.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Власні тести бота. Без живих LLM-викликів у CI — мок/replay.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      // Поріг — на ПУРЕ-ЛОГІЦІ (юніт-покритій). Браузер/агент/cli — інтеграційні, поза гейтом.
      include: [
        "src/eval/**",
        "src/checklist/**",
        "src/knowledge/**",
        "src/artifacts/testcase-md.ts",
        "src/observe/parse-aria.ts",
        "src/design/schema.ts",
        "src/validate/index.ts",
        "src/prompts/index.ts",
        "src/llm/structured.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
