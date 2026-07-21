// applyTheme(accent, baseTheme) — derives the full palette and writes it as
// `--eb-*` CSS custom properties on :root. Switching either = calling it
// again. The synced prefs document is the source of truth for both choices
// (decisions.md §10); localStorage only caches them so boot paints without
// a flash before the first snapshot arrives.

import {
  ACCENTS,
  BASE_THEMES,
  DEFAULT_ACCENT,
  GENDER_PALETTE,
  GENDER_PALETTE_LIGHT,
  LIGHT_THEMES,
  mix,
  NICK_PALETTE,
  NICK_PALETTE_LIGHT,
  STATUS_COLORS,
  type AccentId,
  type BaseThemeId,
} from "./tokens.js";

const ACCENT_STORAGE_KEY = "eb.accent";
const BASE_THEME_STORAGE_KEY = "eb.baseTheme";
const COLORBLIND_STORAGE_KEY = "eb.colorblind";
const DEFAULT_BASE_THEME: BaseThemeId = "slate";

/** F-Chat [color=…] names (the wiki's fixed 12). Wire colors, not theme
 * colors — but tokens, so each ground retunes them for contrast. On paper,
 * "white" maps to a legible warm gray rather than lying invisibly. */
const BBC_DARK = {
  red: "#f44",
  blue: "#1e90ff",
  white: "#ffffff",
  yellow: "#e5d45a",
  pink: "#ffcbdb",
  gray: "#d3d3d3",
  green: "#4f4",
  orange: "#ffa500",
  purple: "#e2afff",
  brown: "#a9825d",
  cyan: "#00ffff",
} as const;

const BBC_LIGHT = {
  red: "#c22626",
  blue: "#1c62c9",
  white: "#8d8577",
  yellow: "#8f7500",
  pink: "#bb4f7a",
  gray: "#7a7268",
  green: "#2e7d32",
  orange: "#b26a00",
  purple: "#7a45ad",
  brown: "#7d5f3f",
  cyan: "#00727e",
} as const;

/** The complete set of custom properties for one accent + base choice. */
export function themeVariables(
  accent: AccentId,
  baseTheme: BaseThemeId = DEFAULT_BASE_THEME,
  colorblind = false,
): Record<string, string> {
  const accentHex = ACCENTS[accent].hex;
  const { heading, bg, side, side2, head, text, dim, meta, faint, border } =
    BASE_THEMES[baseTheme];
  const light = LIGHT_THEMES.has(baseTheme);
  const status = colorblind
    ? light
      ? STATUS_COLORS.colorblindLight
      : STATUS_COLORS.colorblindDark
    : light
      ? STATUS_COLORS.light
      : STATUS_COLORS.dark;
  const bbc = light ? BBC_LIGHT : BBC_DARK;
  const nicks = light ? NICK_PALETTE_LIGHT : NICK_PALETTE;
  const genders = light ? GENDER_PALETTE_LIGHT : GENDER_PALETTE;
  return {
    ...Object.fromEntries(
      nicks.map((hex, index) => [`--eb-nick-${String(index)}`, hex]),
    ),
    ...Object.fromEntries(
      Object.entries(genders).map(([slug, hex]) => [
        `--eb-gender-${slug}`,
        hex,
      ]),
    ),
    "--eb-heading": heading,
    "--eb-bg": bg,
    "--eb-side": side,
    "--eb-side2": side2,
    "--eb-head": head,
    "--eb-text": text,
    "--eb-dim": dim,
    "--eb-meta": meta,
    "--eb-faint": faint,
    "--eb-border": border,
    "--eb-accent": accentHex,
    // accentText = mix(accent, text, 0.04 dark / 0.62 parchment) — accent
    // used as readable text (links, @mentions, #channel); fills keep the
    // raw accent. AA ≥4.55:1 dark, ≥4.86:1 parchment, for all five accents.
    "--eb-accent-text": mix(accentHex, text, light ? 0.62 : 0.04),
    "--eb-accent-soft": mix(accentHex, bg, 0.84),
    "--eb-accent-med": mix(accentHex, bg, 0.5),
    // Role system (COMPONENTS.md): the admin `@` glyph color.
    "--eb-admin": mix(accentHex, text, 0.4),
    "--eb-codebg": mix(text, bg, 0.9),
    "--eb-hover-main": mix(text, bg, 0.95),
    "--eb-hover": mix(text, side, 0.93),
    "--eb-ok": status.ok,
    "--eb-warn": accent === "moss" ? status.warnMoss : status.warn,
    "--eb-danger": status.danger,
    "--eb-radius": "9px",
    "--eb-bbc-red": bbc.red,
    "--eb-bbc-blue": bbc.blue,
    "--eb-bbc-white": bbc.white,
    "--eb-bbc-yellow": bbc.yellow,
    "--eb-bbc-pink": bbc.pink,
    "--eb-bbc-gray": bbc.gray,
    "--eb-bbc-green": bbc.green,
    "--eb-bbc-orange": bbc.orange,
    "--eb-bbc-purple": bbc.purple,
    "--eb-bbc-black": mix(text, bg, 0.55),
    "--eb-bbc-brown": bbc.brown,
    "--eb-bbc-cyan": bbc.cyan,
  };
}

export function applyTheme(
  accent: AccentId,
  baseTheme: BaseThemeId = DEFAULT_BASE_THEME,
  colorblind = false,
): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(
    themeVariables(accent, baseTheme, colorblind),
  )) {
    root.style.setProperty(name, value);
  }
  // Shape-coded presence dots hang off this class (base.css) — CSS-only,
  // so components never re-render for a vision-profile switch.
  root.classList.toggle("eb-colorblind", colorblind);
}

export function savedAccent(): AccentId {
  const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
  // Object.hasOwn, not `in`: a poisoned key like "toString" would pass the
  // prototype-chain check and brick the app at boot.
  return stored !== null && Object.hasOwn(ACCENTS, stored)
    ? (stored as AccentId)
    : DEFAULT_ACCENT;
}

export function savedBaseTheme(): BaseThemeId {
  const stored = localStorage.getItem(BASE_THEME_STORAGE_KEY);
  return stored !== null && Object.hasOwn(BASE_THEMES, stored)
    ? (stored as BaseThemeId)
    : DEFAULT_BASE_THEME;
}

export function savedColorblind(): boolean {
  return localStorage.getItem(COLORBLIND_STORAGE_KEY) === "on";
}

/**
 * Server prefs → theme. Applies and re-caches when any choice changed.
 * Unknown ids are skipped per field — an older client must not repaint to
 * default because a newer one saved a theme it doesn't know.
 */
export function hydrateTheme(prefs: {
  accent: string;
  baseTheme: string;
  colorblindMode?: boolean;
}): void {
  const accent = Object.hasOwn(ACCENTS, prefs.accent)
    ? (prefs.accent as AccentId)
    : savedAccent();
  const baseTheme = Object.hasOwn(BASE_THEMES, prefs.baseTheme)
    ? (prefs.baseTheme as BaseThemeId)
    : savedBaseTheme();
  const colorblind = prefs.colorblindMode ?? savedColorblind();
  if (
    accent === savedAccent() &&
    baseTheme === savedBaseTheme() &&
    colorblind === savedColorblind()
  ) {
    return;
  }
  localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  localStorage.setItem(BASE_THEME_STORAGE_KEY, baseTheme);
  localStorage.setItem(COLORBLIND_STORAGE_KEY, colorblind ? "on" : "off");
  applyTheme(accent, baseTheme, colorblind);
}
