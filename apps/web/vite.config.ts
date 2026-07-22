import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin /api in dev; production serves web + API from one
      // Fastify (M1 step 11). The E2E harness points this at its server.
      "/api": process.env["EMBERCHAT_API_PROXY"] ?? "http://127.0.0.1:3000",
      "/gateway": {
        target: process.env["EMBERCHAT_API_PROXY"] ?? "http://127.0.0.1:3000",
        ws: true,
      },
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    // Default environment is node (the bulk of the suite is pure logic);
    // component-render tests opt into jsdom with a per-file
    // `// @vitest-environment jsdom` docblock (issue #268).
    setupFiles: ["./vitest.setup.ts"],
  },
});
