// ESLint flat config (ESLint 10 + typescript-eslint 8).
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "runs/**", ".auth/**", ".playwright-cli/**"] },
  ...tseslint.configs.recommended,
  {
    // Boundary rule (ADR-0007): browser backends — ONLY through browser/gateway.ts.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/browser/backends/*"],
              message:
                "Import browser backends only through src/browser/gateway.ts (ADR-0007).",
            },
          ],
        },
      ],
    },
  },
  {
    // Exception: gateway/backends themselves; tests and spike scripts — test backends in isolation.
    files: ["src/browser/**", "tests/**", "scripts/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
