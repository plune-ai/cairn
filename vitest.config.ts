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
    // src/cli/index.ts loads dotenv/config: point it at a file that does not exist, so a developer's .env
    // (DECIDER=jev with DECIDER_SHADOW=1, real keys) never reaches a test, exactly as in CI, which has none.
    env: { DOTENV_CONFIG_PATH: "tests/no-such.env" },
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
        "src/agent/testcase-docs.ts",
        // C1-01 — shared umbrella core: pure flag→config + modality registry/dispatch.
        // (modalities/explore.ts + reporting.ts are CLI/agent glue → integration, outside the gate.)
        "src/core/config.ts",
        "src/core/modality.ts",
        "src/core/registry.ts",
        // ADR-0022 — decision layer: caps, wire format, guard, redaction, factory, doctor (fetch injected).
        "src/decider/**",
        "scripts/benchmark-core.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
