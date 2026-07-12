import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin /api in dev; production serves web + API from one
      // Fastify (M1 step 11). The E2E harness points this at its server.
      "/api": process.env["EMBERLINE_API_PROXY"] ?? "http://127.0.0.1:3000",
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
