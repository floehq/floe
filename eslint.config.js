import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Match existing code style: semicolons required
      semi: ["error", "always"],
      // No explicit `any` - warn only (existing code uses `as any` in tests)
      "@typescript-eslint/no-explicit-any": ["error", { "ignoreRestArgs": true }],
      // Unused vars - allow underscore-prefixed
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Require double quotes (matching existing style)
      quotes: ["error", "double", { avoidEscape: true }],
      // Handled by prettier
      indent: "off",
      // Allow require imports (for dynamic imports)
      "@typescript-eslint/no-require-imports": "off",
      // Disable preserve-caught-error: new ESLint v10 rule, codebase predates it
      "preserve-caught-error": "off",
    },
  },
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/*.js"],
  }
);
