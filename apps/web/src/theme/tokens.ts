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
  faint: "#726a5f",
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
    faint: "#6e675d",
    border: "#282520",
  },
} as const satisfies Record<BaseThemeId, Record<keyof typeof NEUTRALS, string>>;

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

/** Deterministic per-nick colors: palette[sum(charCodes) % length]. */
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

export function nickColor(nick: string): string {
  let sum = 0;
  for (const char of nick) {
    sum += char.codePointAt(0) ?? 0;
  }
  return NICK_PALETTE[sum % NICK_PALETTE.length]!;
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
