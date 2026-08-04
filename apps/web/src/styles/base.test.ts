// The global sheet's numbers, checked against the code that depends on them.
// base.css cannot import a constant and the E2E cannot import a stylesheet, so
// the agreement is asserted here — the same shape popover.test.ts uses for
// --eb-popover-margin.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { TARGET_MIN_PX } from "../../e2e/touch-targets.js";

// Read as text rather than imported: vitest stubs CSS imports out. Vitest's
// cwd is the web app.
const baseCss = readFileSync(resolve("src/styles/base.css"), "utf8");

describe("--eb-touch-target (base.css)", () => {
  // Every phone-tier hit area is sized from this token and the E2E measures
  // the result against TARGET_MIN_PX. Move one without the other and the sweep
  // either passes controls that are short or fails ones that are not.
  it("declares the floor the touch-target sweep measures against", () => {
    expect(baseCss).toContain(`--eb-touch-target: ${String(TARGET_MIN_PX)}px;`);
  });
});
