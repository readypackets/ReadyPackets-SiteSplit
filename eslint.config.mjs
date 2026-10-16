import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "client/dist/**",
      "client/dist-public/**",
      "client/dist-portal/**",
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "drizzle/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // This mature codebase has a known historical unused-symbol baseline.
      // TypeScript remains a required hard gate; re-enable this rule for new
      // code after the tracked cleanup backlog is resolved.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
);
