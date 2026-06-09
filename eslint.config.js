// ESLint flat config (ESLint 10 + typescript-eslint 8).
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "runs/**", ".auth/**", ".playwright-cli/**"] },
  ...tseslint.configs.recommended,
  {
    // Правило межі (ADR-0007): бекенди браузера — ТІЛЬКИ через browser/gateway.ts.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/browser/backends/*"],
              message:
                "Бекенди браузера імпортуй лише через src/browser/gateway.ts (ADR-0007).",
            },
          ],
        },
      ],
    },
  },
  {
    // Виняток: gateway/backends — самі; тести й спайк-скрипти — тестують бекенди в ізоляції.
    files: ["src/browser/**", "tests/**", "scripts/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
