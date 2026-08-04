// The global sheet's numbers, checked against the code that depends on them.
// base.css cannot import a constant and the E2E cannot import a stylesheet, so
// the agreement is asserted here — the same shape popover.test.ts uses for
// --eb-popover-margin.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Every stylesheet the app ships, as `[path, text]`. */
function stylesheets(dir = resolve("src")): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return stylesheets(path);
    }
    return entry.name.endsWith(".css")
      ? ([[path, readFileSync(path, "utf8")]] as [string, string][])
      : [];
  });
}

describe("viewport units (MP2 §7)", () => {
  // The dynamic viewport units are the obvious-looking answer to the soft
  // keyboard and the wrong one: `dvh` tracks the browser's own retracting
  // chrome, tracks it *per frame* during the retraction, and on iOS does not
  // account for the keyboard at all — so a shell sized in `dvh` would jitter
  // while scrolling and still sit behind the keyboard. lib/visual-viewport.ts
  // is the one source of keyboard truth and publishes a measured inset
  // instead. A stylesheet reaching for `dvh`/`svh`/`lvh` is re-answering a
  // question that has an answer, so the invariant is checked rather than
  // written down.
  it("are the static ones — no dvh/svh/lvh anywhere", () => {
    const offenders = stylesheets()
      .filter(([, css]) => /\b[\d.]+(?:dvh|svh|lvh|dvw|svw|lvw)\b/u.test(css))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
