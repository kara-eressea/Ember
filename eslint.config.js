import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.turbo/**", "**/coverage/**", "prototype/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    // Plain-node scripts (scripts/*.mjs, config files).
    languageOptions: { globals: globals.node },
  },
  {
    // The push service worker (design/web-push.md §4) is the one .js file that
    // is neither a script nor a bundle: it ships verbatim out of public/ and
    // runs in a ServiceWorkerGlobalScope, so `self`, `clients` and friends are
    // its globals rather than node's.
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
);
