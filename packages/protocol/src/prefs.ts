// User preferences (M5). One flat document per app account, synced across
// every device (decisions.md §10). The server stores a sparse jsonb patch
// document — absent keys mean "default" — and `prefs.set` merges shallow
// patches into it, so the document MUST stay flat: nesting would make the
// jsonb `||` merge clobber sibling keys.
//
// The wire always carries the fully resolved object (`resolvePrefs`), never
// the sparse form. Each preferences pane adds its fields here alongside its
// milestone step; `sendDelaySeconds` predates this document and stays a
// dedicated column.

import { z } from "zod";

/** Accent ids — mirrored by the web theme's ACCENTS palette. */
export const ACCENT_IDS = ["amber", "clay", "dusk", "burnt", "moss"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];

/** Base (neutral) themes — dark variants only in M5 (decisions.md §10);
 * "slate" is the original Slate Cozy set, "charcoal" the dimmer near-black. */
export const BASE_THEME_IDS = ["slate", "charcoal"] as const;
export type BaseThemeId = (typeof BASE_THEME_IDS)[number];

export const DENSITIES = ["cozy", "compact"] as const;
export const FONT_SIZES = ["s", "m", "l"] as const;
/** `[12:04]` · `[12:04:33]` · hidden. */
export const TIMESTAMP_FORMATS = ["time", "seconds", "off"] as const;

/**
 * Field validators — deliberately no `.default()` here: zod fires defaults
 * even through `.partial()`, which would turn a one-key patch into a
 * full-defaults document that clobbers the user's other stored prefs.
 * Defaults live in PREFS_DEFAULTS.
 */
const prefsShape = {
  /** UI accent (theme hue). */
  accent: z.enum(ACCENT_IDS),
  /** Base neutral palette. */
  baseTheme: z.enum(BASE_THEME_IDS),
  /** Message row spacing. */
  density: z.enum(DENSITIES),
  /** Message body font size. */
  fontSize: z.enum(FONT_SIZES),
  /** Timestamp rendering in the log. */
  timestampFormat: z.enum(TIMESTAMP_FORMATS),
  use24HourClock: z.boolean(),
  /** Hide the sender on back-to-back messages from the same person. */
  groupConsecutive: z.boolean(),
  /** Fixed timestamp/name columns so message text lines up (M1 UAT). */
  alignedColumns: z.boolean(),
  /** Highlight messages that name the receiving identity's character. */
  highlightOwnNick: z.boolean(),
} as const;

/** The full resolved prefs shape — every field present. */
export const userPrefsSchema = z.object(prefsShape);

export type UserPrefs = z.infer<typeof userPrefsSchema>;

/**
 * A client-supplied patch: any subset of prefs fields. Present keys are
 * validated strictly — a bad value is the client's error, not something to
 * silently coerce.
 */
export const userPrefsPatchSchema = z.object(prefsShape).partial();

export type UserPrefsPatch = z.infer<typeof userPrefsPatchSchema>;

export const PREFS_DEFAULTS: UserPrefs = {
  accent: "dusk",
  baseTheme: "slate",
  density: "cozy",
  fontSize: "m",
  timestampFormat: "time",
  use24HourClock: true,
  groupConsecutive: false,
  alignedColumns: false,
  highlightOwnNick: true,
};

/**
 * Resolve a stored patch document to full prefs, field by field: a value an
 * old server wrote for a since-changed field (or plain garbage) falls back
 * to that field's default without dragging its valid siblings down. The
 * stored form is untrusted history, not a client to 400 at.
 */
export function resolvePrefs(stored: unknown): UserPrefs {
  const source: Record<string, unknown> =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  const resolved: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(prefsShape)) {
    const parsed = field.safeParse(source[key]);
    resolved[key] = parsed.success
      ? parsed.data
      : PREFS_DEFAULTS[key as keyof UserPrefs];
  }
  return resolved as UserPrefs;
}
