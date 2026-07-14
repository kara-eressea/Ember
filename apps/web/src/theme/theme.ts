// applyTheme(accent) — derives the full palette and writes it as `--eb-*`
// CSS custom properties on :root. Switching accent = calling it again
// (COMPONENTS.md: only the accent hue changes; neutrals stay fixed).

import {
  ACCENTS,
  DANGER,
  DEFAULT_ACCENT,
  mix,
  NEUTRALS,
  OK,
  WARN,
  WARN_MOSS,
  type AccentId,
} from "./tokens.js";

const ACCENT_STORAGE_KEY = "eb.accent";

/** The complete set of custom properties for one accent choice. */
export function themeVariables(accent: AccentId): Record<string, string> {
  const accentHex = ACCENTS[accent].hex;
  const { heading, bg, side, side2, head, text, dim, faint, border } = NEUTRALS;
  return {
    "--eb-heading": heading,
    "--eb-bg": bg,
    "--eb-side": side,
    "--eb-side2": side2,
    "--eb-head": head,
    "--eb-text": text,
    "--eb-dim": dim,
    "--eb-faint": faint,
    "--eb-border": border,
    "--eb-accent": accentHex,
    "--eb-accent-soft": mix(accentHex, bg, 0.84),
    "--eb-accent-med": mix(accentHex, bg, 0.5),
    // Role system (COMPONENTS.md): the admin `@` glyph color.
    "--eb-admin": mix(accentHex, text, 0.4),
    "--eb-codebg": mix(text, bg, 0.9),
    "--eb-hover-main": mix(text, bg, 0.95),
    "--eb-hover": mix(text, side, 0.93),
    "--eb-ok": OK,
    "--eb-warn": accent === "moss" ? WARN_MOSS : WARN,
    "--eb-danger": DANGER,
    "--eb-radius": "9px",
    // F-Chat [color=…] names (the wiki's fixed 12, dark-theme palette).
    // Wire colors, not theme colors — but tokens, so a theme can retune
    // them for contrast.
    "--eb-bbc-red": "#f44",
    "--eb-bbc-blue": "#1e90ff",
    "--eb-bbc-white": "#ffffff",
    "--eb-bbc-yellow": "#e5d45a",
    "--eb-bbc-pink": "#ffcbdb",
    "--eb-bbc-gray": "#d3d3d3",
    "--eb-bbc-green": "#4f4",
    "--eb-bbc-orange": "#ffa500",
    "--eb-bbc-purple": "#e2afff",
    "--eb-bbc-black": mix(text, bg, 0.55),
    "--eb-bbc-brown": "#a9825d",
    "--eb-bbc-cyan": "#00ffff",
  };
}

export function applyTheme(accent: AccentId): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(accent))) {
    root.style.setProperty(name, value);
  }
}

export function savedAccent(): AccentId {
  const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
  // Object.hasOwn, not `in`: a poisoned key like "toString" would pass the
  // prototype-chain check and brick the app at boot.
  return stored !== null && Object.hasOwn(ACCENTS, stored)
    ? (stored as AccentId)
    : DEFAULT_ACCENT;
}

export function setAccent(accent: AccentId): void {
  localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  applyTheme(accent);
}

/**
 * Server prefs → theme. The synced prefs document is the accent's source of
 * truth (decisions.md §10); localStorage is only the pre-hydration flash
 * cache that boot paints from. Unknown ids are skipped — an older client
 * must not repaint to default because a newer one saved an accent it
 * doesn't know.
 */
export function hydrateAccent(accent: string): void {
  if (!Object.hasOwn(ACCENTS, accent) || accent === savedAccent()) {
    return;
  }
  setAccent(accent as AccentId);
}
