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
