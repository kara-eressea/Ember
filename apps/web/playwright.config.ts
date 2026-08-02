// E2E against the full stack: Postgres (testcontainers) + fchat-sim + the
// built server process are booted in global-setup; the vite dev server below
// proxies /api to that server (same-origin, like production).

import { defineConfig } from "@playwright/test";

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a port number, got "${raw}"`);
  }
  return port;
}

// Overridable so two working copies (parallel worktrees) can run the suite at
// the same time instead of the second colliding with the first's stack. The
// other two ports are already collision-free: fchat-sim binds 0 and
// testcontainers maps Postgres to a free host port.
export const API_PORT = envPort("E2E_API_PORT", 39311);
export const WEB_PORT = envPort("E2E_WEB_PORT", 39312);
// `vite preview` serving apps/web/dist — the bundle a self-host actually
// ships. The Firefox caret project runs against this one (see below).
export const PREVIEW_PORT = envPort("E2E_PREVIEW_PORT", WEB_PORT + 1);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // The HTML report is what makes a CI flake readable after the fact (which
  // test, which retry, the attached trace) — the workflow uploads
  // playwright-report/ unconditionally, so it has to actually be written.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Pinned rather than left to default to the runner's core count: CI would
  // otherwise change parallel load whenever GitHub resizes ubuntu-latest, and
  // timing-sensitive flakes reproduce differently at different worker counts.
  // 2 is what the runner gives today, so this is a no-op that stays one
  // (standing to-do, 2026-08-01).
  workers: process.env.CI ? 2 : "50%",
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    // Keep a full trace whenever a test fails (including the retry) so CI
    // failures that don't reproduce locally can still be inspected after the
    // fact — uploaded as an artifact from the workflow.
    trace: "retain-on-failure",
  },
  // The suite is Chromium's; Firefox runs the typography spec alone. Caret and
  // font metrics are the one area where the engines genuinely disagree (#408,
  // #434 were both metrics bugs a single engine could hide), and a caret is
  // painted, not queryable — so it needs a real second engine rather than a
  // second assertion. Everything else behaves the same in both, and a full
  // second pass would roughly double the E2E leg of CI.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "firefox",
      // Gecko leaves the caret out of every screenshot, so the caret tests
      // film it instead and read the blink back out of the recording. Video
      // has to be declared here (Playwright forbids test.use({ video })), and
      // the size matches the viewport 1:1 so a DOM bounding box indexes
      // straight into a decoded frame.
      use: {
        browserName: "firefox",
        // …and against `vite preview`, i.e. the bundle a self-host actually
        // serves: the caret bug was reported off a production deployment and
        // measured green on the dev server twice, so at least one of the two
        // caret passes runs on the built output.
        baseURL: `http://127.0.0.1:${String(PREVIEW_PORT)}`,
        viewport: { width: 1280, height: 720 },
        video: { mode: "on", size: { width: 1280, height: 720 } },
      },
      testMatch: ["typography.spec.ts"],
      // Only the caret tests: the rest of the spec reads computed style, which
      // no second engine can disagree about.
      grep: /caret/,
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      // Generous: on a cold CI runner this window also covers global-setup's
      // first-time postgres image pull.
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env: {
        EMBERCHAT_API_PROXY: `http://127.0.0.1:${String(API_PORT)}`,
      },
    },
    {
      // The built bundle, for the caret pass. `turbo e2e` depends on the web
      // app's own build, so dist/ is always fresh; a bare `playwright test`
      // needs `pnpm --filter @emberchat/web build` first.
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${String(PREVIEW_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(PREVIEW_PORT)}`,
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env: {
        EMBERCHAT_API_PROXY: `http://127.0.0.1:${String(API_PORT)}`,
      },
    },
  ],
});
