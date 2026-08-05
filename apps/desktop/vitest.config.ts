import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this package's own tests. `server-runtime/` is a deployed copy of
    // the server — its test files come along for the ride and are emphatically
    // not ours to run (and could not run anyway: that tree's native modules
    // are built for Electron's ABI, not Node's).
    include: ["src/**/*.test.ts"],
  },
});
