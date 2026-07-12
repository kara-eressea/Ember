// E2E against the full stack: Postgres (testcontainers) + fchat-sim + the
// built server process are booted in global-setup; the vite dev server below
// proxies /api to that server (same-origin, like production).

import { defineConfig } from "@playwright/test";

export const API_PORT = 39311;
export const WEB_PORT = 39312;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
  },
  webServer: {
    command: `pnpm exec vite --port ${String(WEB_PORT)} --strictPort`,
    url: `http://127.0.0.1:${String(WEB_PORT)}`,
    reuseExistingServer: !process.env.CI,
    env: {
      EMBERLINE_API_PROXY: `http://127.0.0.1:${String(API_PORT)}`,
    },
  },
});
