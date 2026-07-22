// applyTheme(accent, baseTheme) — derives the full palette and writes it as
// `--eb-*` CSS custom properties on :root. Switching either = calling it
// again. The synced prefs document is the source of truth for both choices
// (decisions.md §10); localStorage only caches them so boot paints without
// a flash before the first snapshot arrives.

import {
  PREFS_DEFAULTS,
  UI_FONT_SIZES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from "@emberchat/protocol";
import {
  ACCENTS,
  BASE_THEMES,
  DEFAULT_ACCENT,
  GENDER_PALETTE,
  GENDER_PALETTE_LIGHT,
  KINK_PALETTE,
  KINK_PALETTE_LIGHT,
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
const UI_FONT_STORAGE_KEY = "eb.uiFontSize";
const UI_SCALE_STORAGE_KEY = "eb.uiScale";
const DEFAULT_BASE_THEME: BaseThemeId = "slate";

/** F-Chat [color=…] names (the wiki's fixed 12). Wire colors, not theme
 * colors — but tokens, so each ground retunes them for contrast. Retuned
 * for the composer toolbar's swatch popover (#205): each name keeps its hue
 * identity but is normalized into the palette's readable band (≥4.5:1 on
 * the active ground), exactly like the per-nick palette — never the raw web
 * colors. black/white/gray map to readable warm neutrals instead of
 * vanishing into the ground. Dark themes share this one set; Parchment
 * derives from it below via mix(name, text, .52) — the same rule as nicks —
 * with white → text and black → the darkest readable warm (heading). */
const BBC_DARK = {
  red: "#e08a6a",
  orange: "#e6a75a",
  yellow: "#d8c06a",
  pink: "#c294b0",
  green: "#8bb173",
  cyan: "#79b6b6",
  blue: "#8f9bc9",
  purple: "#a892c6",
  brown: "#c0906a",
  black: "#8a8078",
  gray: "#a89e92",
  white: "#ece7e0",
} as const;

type BbcName = keyof typeof BBC_DARK;

/** The Parchment set: the dark hues darkened onto paper (see BBC_DARK). */
function bbcLight(text: string, heading: string): Record<BbcName, string> {
  return Object.fromEntries(
    (Object.keys(BBC_DARK) as BbcName[]).map((name) => [
      name,
      name === "white"
        ? text
        : name === "black"
          ? heading
          : mix(BBC_DARK[name], text, 0.52),
    ]),
  ) as Record<BbcName, string>;
}

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
  const bbc = light ? bbcLight(text, heading) : BBC_DARK;
  const nicks = light ? NICK_PALETTE_LIGHT : NICK_PALETTE;
  const genders = light ? GENDER_PALETTE_LIGHT : GENDER_PALETTE;
  const kinks = light ? KINK_PALETTE_LIGHT : KINK_PALETTE;
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
    ...Object.fromEntries(
      Object.entries(kinks).map(([slug, hex]) => [`--eb-kink-${slug}`, hex]),
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
    "--eb-bbc-black": bbc.black,
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

// ── Interface font size + scale (issue #319) ───────────────────────────────
// Two Appearance prefs, applied on the root element alongside the palette:
//
//  • UI font size (S/M/L) → the root <html> font-size. The shell's chrome is
//    px-heavy, but its interactive controls (buttons/inputs use `font:
//    inherit`) and every element without an explicit size cascade from this
//    base, so the ramp scales interface *type* without touching layout
//    spacing or the #303 column clamps — the type-only knob, mirroring the
//    message-body font pref's spirit.
//  • UI scale (%) → root `zoom`, the browser-zoom equivalent. The layouts are
//    px-based (a rem-basis rescale wouldn't bite), and `zoom` scales type and
//    box together while keeping the #303 resizable-sidebar clamps
//    proportional: the drag reads getBoundingClientRect and writes a px CSS
//    var, both living inside the zoomed root, so the [180,400] bounds stay
//    self-consistent at any scale.
//
// They compose: `zoom` scales the font-size-derived type too, so UI-font L at
// 125% is simply the larger type inside the larger shell.

/** Root font-size (px) for each interface-type step. M = 13px, the historical
 * body base, so the default is a no-op. */
export const UI_FONT_PX: Record<(typeof UI_FONT_SIZES)[number], number> = {
  s: 12,
  m: 13,
  l: 15,
};

const DEFAULT_UI_FONT = PREFS_DEFAULTS.uiFontSize;
const DEFAULT_UI_SCALE = PREFS_DEFAULTS.uiScale;

/** A stored/percent scale → the finite `zoom` factor, clamped to the
 * supported band. A non-finite or out-of-range value falls back to 100%. */
export function uiScaleFactor(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 1;
  }
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, percent));
  return clamped / 100;
}

function isUiFontSize(value: string): value is (typeof UI_FONT_SIZES)[number] {
  return (UI_FONT_SIZES as readonly string[]).includes(value);
}

/** Write the interface font-size + scale onto :root. Idempotent — safe to
 * call on every prefs fan-out. */
export function applyInterface(
  uiFontSize: (typeof UI_FONT_SIZES)[number],
  uiScale: number,
): void {
  const root = document.documentElement;
  root.style.fontSize = `${String(UI_FONT_PX[uiFontSize])}px`;
  // `zoom` takes a unitless factor; 1 = no scaling. Kept as a string so the
  // property is always written (some engines drop `zoom: 1` otherwise).
  root.style.zoom = String(uiScaleFactor(uiScale));
}

export function savedUiFontSize(): (typeof UI_FONT_SIZES)[number] {
  const stored = localStorage.getItem(UI_FONT_STORAGE_KEY);
  return stored !== null && isUiFontSize(stored) ? stored : DEFAULT_UI_FONT;
}

export function savedUiScale(): number {
  const stored = localStorage.getItem(UI_SCALE_STORAGE_KEY);
  if (stored === null) {
    return DEFAULT_UI_SCALE;
  }
  const parsed = Number.parseInt(stored, 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_UI_SCALE;
  }
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, parsed));
}

/**
 * Server prefs → interface font/scale. Applies and re-caches when either
 * choice changed, mirroring hydrateTheme's no-op-on-match discipline so an
 * unrelated pref fan-out never repaints the shell.
 */
export function hydrateInterface(prefs: {
  uiFontSize?: string;
  uiScale?: number;
}): void {
  const uiFontSize =
    prefs.uiFontSize !== undefined && isUiFontSize(prefs.uiFontSize)
      ? prefs.uiFontSize
      : savedUiFontSize();
  const uiScale =
    typeof prefs.uiScale === "number" &&
    Number.isFinite(prefs.uiScale) &&
    prefs.uiScale >= UI_SCALE_MIN &&
    prefs.uiScale <= UI_SCALE_MAX
      ? Math.round(prefs.uiScale)
      : savedUiScale();
  if (uiFontSize === savedUiFontSize() && uiScale === savedUiScale()) {
    return;
  }
  localStorage.setItem(UI_FONT_STORAGE_KEY, uiFontSize);
  localStorage.setItem(UI_SCALE_STORAGE_KEY, String(uiScale));
  applyInterface(uiFontSize, uiScale);
}
