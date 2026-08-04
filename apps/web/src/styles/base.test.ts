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

/**
 * A stylesheet with its comments removed.
 *
 * Every text guard below strips first. The sheets are densely annotated and
 * the annotations cite GitHub issues by number — around 124 of them — which
 * a colour regex reads as `#377` the three-digit hex, and a breakpoint regex
 * reads as the retired `@media (max-width: 820px)` that chat.module.css
 * explains it no longer has. Stripping is what makes a hit mean something.
 */
function uncommented(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

describe("colour literals (MP1 §6)", () => {
  // Accents are user-swappable and the base themes are nothing but token
  // sets, so a hex written straight into a rule is a colour that quietly
  // stops following the theme — it survives every theme switch looking
  // exactly right in the palette it was picked from and wrong in the other
  // five. Nobody notices until a screenshot of the crimson instance has one
  // stubbornly indigo border in it.
  it("do not exist — every colour comes from a token", () => {
    const offenders = stylesheets().flatMap(([path, css]) =>
      [...uncommented(css).matchAll(/#[0-9a-fA-F]{3,8}\b/gu)].map(
        (match) => `${path}: ${match[0]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("width media queries (MP1 §2, §6)", () => {
  // A width media query is blind to the `zoom` the interface-scale
  // preference puts on :root — at 125% a 1000px window lays out as 800 but
  // `max-width: 940px` still sees 1000, so the rule that was supposed to
  // fire does not and the columns overflow. The tier is therefore computed
  // in JS against the corrected width and published as `:root[data-layout]`;
  // a stylesheet asking about width directly has gone around that and will
  // be wrong for every user who is not at 100%. Queries about the *device* —
  // `hover: none`, `pointer: coarse`, `prefers-reduced-motion`,
  // `display-mode` — are not width questions and stay allowed.
  it("are absent — shell geometry keys off data-layout instead", () => {
    const offenders = stylesheets().flatMap(([path, css]) =>
      [...uncommented(css).matchAll(/@media([^{]*)\{/gu)]
        .map((match) => match[1] ?? "")
        .filter((condition) => /(?:min|max)-width/u.test(condition))
        .map((condition) => `${path}: @media ${condition.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * The character ranges the blocks opened by `opener` span, as `[start, end]`
 * offsets into `css` — `start` just past the opening brace, `end` just past
 * the matching one.
 *
 * A scan rather than a regex because the answer wanted is a *range*: a block
 * ends at the brace that closes it, and these blocks contain nested rule
 * sets, so that is not the next `}` — counting depth is exactly the thing
 * regular expressions cannot do. Callers strip comments first, so no brace
 * inside prose can push the count off.
 */
function blockRanges(css: string, opener: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of css.matchAll(opener)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < css.length && depth > 0) {
      const char = css[end];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      end += 1;
    }
    ranges.push([start, end]);
  }
  return ranges;
}

describe("the browser tab (MP3 §7)", () => {
  const css = uncommented(baseCss);
  const standalone = blockRanges(
    css,
    /@media\s*\(\s*display-mode:\s*standalone\s*\)\s*\{/gu,
  );
  const inStandalone = (index: number): boolean =>
    standalone.some(([start, end]) => index >= start && index < end);

  // This is the one place the "installed only" promise is written down as
  // something a machine can check. It cannot be an E2E: an installed window
  // is a thing an operating system makes, and `display-mode` is not
  // emulatable — Blink accepts the feature in `Emulation.setEmulatedMedia`
  // and then ignores it (MP3 §8), so every rule guarded this way is
  // unreachable from Playwright on every platform. A source assertion is the
  // only falsifiable home the invariant has.

  // The zero defaults are the whole mechanism: outside an installed window
  // the four tokens are 0px, so every surface that pads by them is doing
  // arithmetic on zero and lays out exactly as it did before MP3 existed.
  // Lose the defaults and the tokens resolve to nothing instead, which is
  // not 0 — `padding: var(--eb-safe-top)` with an undefined token drops the
  // whole declaration, and the shells shift.
  it("gets four safe-area tokens that are 0px", () => {
    const plain = blockRanges(css, /:root\s*\{/gu)
      .filter(([start]) => !inStandalone(start))
      .map(([start, end]) => css.slice(start, end))
      .join("\n");
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(plain).toContain(`--eb-safe-${side}: 0px;`);
    }
  });

  // Every reader of an actual inset has to sit behind the display-mode gate.
  // One `env(safe-area-inset-*)` that escapes it is a tab that pads itself
  // for a notch it is drawn under anyway — a strip of dead space at the top
  // of the page in Safari, and the thing §7 says will not happen.
  it("never reads env(safe-area-inset-*) outside an installed window", () => {
    const offenders = [...css.matchAll(/env\(safe-area-inset-\w+/gu)]
      .filter((match) => !inStandalone(match.index))
      .map((match) => match[0]);
    expect(offenders).toEqual([]);
  });

  // Pull-to-refresh belongs to the browser: in a tab it is the user's reload
  // gesture and taking it away is a bug, not a feature. Only when there is
  // no address bar behind the gesture does the same pull throw away a live
  // socket and every open conversation's buffer for nothing.
  it("keeps pull-to-refresh — overscroll-behavior-y is installed-only", () => {
    const offenders = [...css.matchAll(/overscroll-behavior-y/gu)]
      .filter((match) => !inStandalone(match.index))
      .map((match) => match[0]);
    expect(offenders).toEqual([]);
  });
});
