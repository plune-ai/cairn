import { defineConfig } from "vitest/config";

export default defineConfig({
  // .tsx (Ink TUI) are transformed by the built-in oxc transformer in vitest 4 (JSX automatic).
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Integration tests spin up real Chromium — generous timeouts are needed.
    testTimeout: 30000,
    hookTimeout: 30000,
    // The bot's own tests. No live LLM calls in CI — mock/replay.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      // Threshold — on PURE LOGIC (unit-covered). Browser/agent/cli — integration, outside the gate.
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
        "src/llm/cost.ts",
        // L1-04 — pure hardening helpers (no-progress detection · run summary · observe degrade · failure path).
        "src/agent/progress.ts",
        "src/agent/summary.ts",
        "src/agent/observe-guard.ts",
        "src/agent/finalize.ts",
        "src/agent/repair-loop.ts",
        "scripts/benchmark-core.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
