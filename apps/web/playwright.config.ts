// E2E against the full stack: Postgres (testcontainers) + fchat-sim + the
// built server process are booted in global-setup; the vite dev server below
// proxies /api to that server (same-origin, like production).

import { defineConfig, devices } from "@playwright/test";

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

/** The phone-device slice, named once: the mobile project claims it and the
 * Chromium project gives it up, so the two partition the suite. */
const MOBILE_SPECS = "mobile-*.spec.ts";

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
  // The suite is Chromium's, on a desktop viewport, plus three small named
  // slices: one on a phone device profile (MP1 package G) and two on Firefox.
  // The phone slice is a partition — those specs run there instead of in the
  // desktop project, not as well. The Firefox ones are a second pass. Both
  // are areas where the engines genuinely disagree and one engine can hide a
  // real bug: caret/font metrics (#408, #434 — a caret is painted, not
  // queryable, so it needs a second engine rather than a second assertion) and
  // message-log scroll geometry (#411, reported off Firefox three times and
  // never reproduced on Chromium). Everything else behaves the same in both,
  // and a full second pass would roughly double the E2E leg of CI.
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      // Everything except the phone-device slice below, so no spec runs twice.
      testIgnore: [MOBILE_SPECS],
    },
    {
      // MP1 package G (#375): the phone tier on an actual phone context —
      // Pixel-class viewport, `isMobile`, `hasTouch`, coarse pointer, no
      // hover. The descriptor is taken whole rather than hand-rolled: the
      // properties that matter here (`hover: none` gating the reveal
      // affordances, a real touch pointer for `page.tap`) come as a set, and
      // half a phone is a worse test than none.
      //
      // Scoped by filename, the way the Firefox projects are: `mobile-*` runs
      // here and nowhere else. It is *not* where the two viewport-crossing
      // specs live (pane-stack, phone-overlays). `setViewportSize` does work
      // inside a mobile context — it neither throws nor is ignored — but it
      // leaves `isMobile` and `hasTouch` exactly as the context was built, so
      // the "back on a desktop viewport" half of those specs would be
      // asserting about a 1280px touchscreen with a phone's user agent and
      // device pixel ratio. They assert about the desktop the shell actually
      // has to restore, so they stay in the plain Chromium project and keep
      // resizing; this project holds the specs that are phone from boot to
      // teardown and never touch the viewport at all.
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
      testMatch: [MOBILE_SPECS],
    },
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
    {
      // The open-at-the-tail family on Gecko (#411). This bug was reported off
      // a Firefox deployment three times and reproduced on Chromium none of
      // them — the scroll geometry it depends on (when a re-measure shifts
      // scrollTop, when a scroll event is dispatched relative to a
      // ResizeObserver delivery) is exactly where the engines are free to
      // differ. A separate project rather than more testMatch on the caret one
      // above, because that project is scoped by `grep: /caret/` and carries
      // video for the film-the-caret trick; neither applies here.
      name: "firefox-tail",
      use: { browserName: "firefox" },
      testMatch: [
        "open-at-tail.spec.ts",
        "focus-read.spec.ts",
        "stick-intent.spec.ts",
      ],
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
