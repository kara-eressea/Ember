// Design tokens — exact values from design/ui/COMPONENTS.md. Components
// style against the CSS custom properties written by applyTheme(), never
// against these constants directly.

import type {
  AccentId as PrefsAccentId,
  BaseThemeId,
} from "@emberchat/protocol";

export type { BaseThemeId };

/** The original Slate Cozy neutral set (COMPONENTS.md tokens). */
export const NEUTRALS = {
  /** Landing hero headings only (COMPONENTS.md §15). */
  heading: "#f4ecde",
  bg: "#1b1917",
  side: "#232120",
  side2: "#2a2725",
  head: "#201e1c",
  text: "#ece7e0",
  dim: "#a89e92",
  // meta = mix(dim, faint, 0.30) — readable meta text (timestamps, helper
  // copy, empty states, section labels); AA ≥4.62:1 on every surface.
  meta: "#988e83",
  // faint = mix(faint₀, text, 0.05) — decorative-only floor (glyphs, pins,
  // disabled, presence dots); allowed to fail body contrast.
  faint: "#787065",
  border: "#332f2b",
} as const;

/** Base themes — dark variants only in M5 (decisions.md §10). The
 * `satisfies` pins the set to the prefs schema's enum, like ACCENTS. */
export const BASE_THEMES = {
  slate: NEUTRALS,
  // Charcoal: the same warm hue family pulled toward black — for OLED and
  // dim rooms. Text/dim/faint drop a touch with it to keep contrast ratios
  // in the same band as slate.
  charcoal: {
    heading: "#f4ecde",
    bg: "#121110",
    side: "#171615",
    side2: "#1c1a19",
    head: "#141312",
    text: "#e9e4dd",
    dim: "#a49a8e",
    // meta = mix(dim, faint, 0.46) — AA ≥4.63:1 on every surface.
    meta: "#8b8377",
    faint: "#6e675d",
    border: "#282520",
  },
  // Parchment (M9): the light variant of the same warm hue family — paper
  // rather than pure white, dark warm text. Every derived token (hover,
  // codebg, accent-soft) flows from these through the same mix() calls, so
  // the derivation structure is untouched.
  parchment: {
    heading: "#35302a",
    bg: "#f6f1e7",
    side: "#efe8db",
    side2: "#e7dfd0",
    head: "#f2ecdf",
    text: "#2e2a24",
    dim: "#675f52",
    // meta = mix(dim, faint, 0.05) — AA ≥4.61:1 on every surface.
    meta: "#696154",
    // faint = mix(faint₀, text, 0.12) — decorative-only floor.
    faint: "#887e70",
    border: "#ddd3c2",
  },
} as const satisfies Record<BaseThemeId, Record<keyof typeof NEUTRALS, string>>;

/** Base themes rendered on a light ground — they take the light-tuned
 * status, nick, and BBCode palettes below. */
export const LIGHT_THEMES: ReadonlySet<BaseThemeId> = new Set(["parchment"]);

/** User-selectable accents; default is Dusk Purple. The `satisfies` pins
 * this palette to the prefs schema's accent enum — adding or renaming an
 * accent fails the build until both sides agree. */
export const ACCENTS = {
  amber: { label: "Amber", hex: "#e6a75a" },
  clay: { label: "Clay Red", hex: "#c87d6a" },
  dusk: { label: "Dusk Purple", hex: "#a892c6" },
  burnt: { label: "Burnt Orange", hex: "#dd955a" },
  moss: { label: "Moss Green", hex: "#88ac72" },
} as const satisfies Record<PrefsAccentId, { label: string; hex: string }>;

export type AccentId = keyof typeof ACCENTS;
export const DEFAULT_ACCENT: AccentId = "dusk";

export const OK = "#8bb173";
export const WARN = "#d0a24f";
/** Moss Green accent shifts the idle/warn dot so it doesn't clash. */
export const WARN_MOSS = "#c9a25e";
export const DANGER = "#e08a6a";

/** Status colors per ground and vision profile (M9). The colorblind set
 * derives from Okabe–Ito: sky-blue ok / amber warn / vermillion danger —
 * hues that stay distinct under deuteranopia and protanopia; the presence
 * dots additionally shape-code (see base.css). */
export const STATUS_COLORS = {
  dark: { ok: OK, warn: WARN, warnMoss: WARN_MOSS, danger: DANGER },
  light: {
    ok: "#54803a",
    warn: "#96741b",
    warnMoss: "#96741b",
    danger: "#b25233",
  },
  colorblindDark: {
    ok: "#56b4e9",
    warn: "#e6b625",
    warnMoss: "#e6b625",
    danger: "#e0703f",
  },
  colorblindLight: {
    ok: "#2a6f9e",
    warn: "#8a6d00",
    warnMoss: "#8a6d00",
    danger: "#b0400e",
  },
} as const;

/** Deterministic per-nick colors: palette[sum(charCodes) % length]. Two
 * palettes, same hue order — the dark one is the original pastel set, the
 * light one the same hues pulled down for contrast on paper. themeVariables
 * writes the active one as --eb-nick-N; nickColor hands out the var so
 * every consumer re-tints on theme switch for free. */
export const NICK_PALETTE = [
  "#a892c6",
  "#c294b0",
  "#8f9bc9",
  "#a6bd94",
  "#88b0b8",
  "#cfa2d4",
  "#c69ac2",
  "#98bda8",
] as const;

// Parchment nick palette = mix(c, text, 0.52) over the dark palette — the
// pastel set is invisible on paper (1.8–2.5:1); darkened, min 4.55:1 on bg.
export const NICK_PALETTE_LIGHT = [
  "#695c72",
  "#755d67",
  "#5d6073",
  "#68715a",
  "#596a6b",
  "#7b6478",
  "#776070",
  "#617163",
] as const;

export function nickIndex(nick: string): number {
  let sum = 0;
  for (const char of nick) {
    sum += char.codePointAt(0) ?? 0;
  }
  return sum % NICK_PALETTE.length;
}

export function nickColor(nick: string): string {
  return `var(--eb-nick-${String(nickIndex(nick))})`;
}

/** Linear RGB lerp between two `#rrggbb` colors; `t` = weight toward `b`. */
export function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const from = parse(a);
  const to = parse(b);
  return (
    "#" +
    from
      .map((v, i) =>
        Math.round(v * (1 - t) + to[i]! * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
