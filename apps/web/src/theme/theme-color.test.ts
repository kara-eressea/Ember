// @vitest-environment jsdom
// The theme-color meta (MP3 §4, #377) — the one thing applyTheme writes that
// is not a custom property, and the only surface the installed window's OS
// chrome reads. A real DOM rather than theme.test.ts's node stub, because what
// is being asserted here IS the DOM manipulation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { applyTheme } from "./theme.js";
import { BASE_THEMES } from "./tokens.js";

function themeColor(): string | null {
  return (
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.getAttribute("content") ?? null
  );
}

describe("applyTheme → meta[name=theme-color]", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("creates the meta when the document has none", () => {
    applyTheme("clay", "charcoal");
    expect(themeColor()).toBe(BASE_THEMES.charcoal.head);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(
      1,
    );
  });

  it("follows base-theme switches, in place", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
    applyTheme("clay", "slate");
    expect(themeColor()).toBe(BASE_THEMES.slate.head);
    // Parchment is the light one — the switch that matters most for an OS
    // chrome that would otherwise stay dark around a paper-white app.
    applyTheme("clay", "parchment");
    expect(themeColor()).toBe(BASE_THEMES.parchment.head);
    // Still one element: repeated switches must not stack metas, or the
    // browser picks the first and the colour freezes on whatever booted.
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(
      1,
    );
  });

  it("is rewritten by an accent or vision-profile switch too", () => {
    applyTheme("clay", "slate");
    applyTheme("moss", "slate", true);
    // Accent and colourblind mode do not move the top-bar token, so the value
    // is unchanged — the point is that the sync runs on every applyTheme and
    // nothing is left stale behind a switch that happens to be a no-op.
    expect(themeColor()).toBe(BASE_THEMES.slate.head);
  });
});

describe("index.html's initial theme-color", () => {
  // The document is coloured before any module has loaded, so index.html
  // carries a literal. It is the DEFAULT theme's `head` token and there is no
  // way to import it into HTML — the same problem base.test.ts has with the
  // numbers base.css cannot import, and the same answer.
  it("is the default theme's head token", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    const content = /<meta name="theme-color" content="([^"]+)"/.exec(
      html,
    )?.[1];
    expect(content).toBe(BASE_THEMES.slate.head);
  });

  // The floor under it (#533): the ground the document is painted with until
  // applyTheme runs. Same literal-in-HTML problem, same guard — and this one
  // is load-bearing on iOS, where an installed window fills the safe-area
  // strips from a document background it samples at load and a transparent
  // document gets black bands for the life of the launch.
  it("seeds --eb-bg with the default theme's bg token", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    const seeded = /--eb-bg:\s*([^;\s]+)\s*;/u.exec(html)?.[1];
    expect(seeded).toBe(BASE_THEMES.slate.bg);
  });

  it("links the manifest and the iOS home-screen icon", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain(
      'rel="apple-touch-icon" href="/icons/apple-touch-icon.png"',
    );
    // Without this, env(safe-area-inset-*) is 0 on every device and the whole
    // of MP3 §3 is arithmetic on nothing.
    expect(html).toContain("viewport-fit=cover");
    // The deprecated Apple pair is a fallback for browsers that cannot load
    // the manifest, and that fallback drops start_url and scope — shipping it
    // makes the installed app worse. Asserted so it cannot drift back in.
    // Matched as a tag, not a substring: the comment above the links explains
    // the omission and names them.
    expect(html).not.toMatch(/<meta[^>]*apple-mobile-web-app/u);
  });
});
