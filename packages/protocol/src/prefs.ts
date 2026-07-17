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
/** Inline images vs name chips with a hover preview (decisions.md §8). */
export const EICON_DISPLAY_MODES = ["inline", "name"] as const;

/** Matches the eicon-name charset the URL builder accepts (web avatar.ts). */
export const EICON_NAME = /^[a-zA-Z0-9_\-\s.]+$/;

/** UTF-8 byte length without TextEncoder/Buffer — this package targets both
 * runtimes and pulls in neither lib. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

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
  /** Render join/part/quit lines in channel logs (live-only lines). */
  showJoinPartQuit: z.boolean(),
  /** Inline eicon images vs name chips with hover preview. */
  eiconDisplay: z.enum(EICON_DISPLAY_MODES),
  /** Off = eicons freeze on their first frame. */
  animateEicons: z.boolean(),
  /** Composer ☺ picker quick-inserts (decisions.md §8 — no search API,
   * favorites are a manual list). Patches replace the whole array. */
  eiconFavorites: z
    .array(z.string().min(1).max(100).regex(EICON_NAME))
    .max(100),
  /** EiconPicker Recents tab (M8): most-recent-first, written on insert
   * and on send (typed eicons count too). Patches replace the array. */
  eiconRecents: z.array(z.string().min(1).max(100).regex(EICON_NAME)).max(50),
  /** Eicon search via the server-local xariah.net index (M8). Off by
   * default and enforced server-side (403) — enabling makes the server
   * download the index from xariah.net, a third-party service; query text
   * itself never leaves the server. */
  eiconSearchEnabled: z.boolean(),
  /** Highlight messages that name the receiving identity's character. */
  highlightOwnNick: z.boolean(),
  /** When-highlighted actions (COMPONENTS.md §12). */
  highlightSound: z.boolean(),
  highlightFlashTitle: z.boolean(),
  highlightBump: z.boolean(),
  /** Row-tint hue: "accent" follows the theme accent; otherwise a fixed one. */
  highlightTint: z.enum(["accent", ...ACCENT_IDS]),
  /** Client idle → STA away (only ever from "online", never clobbering a
   * manually chosen status). */
  autoAwayEnabled: z.boolean(),
  /** Idle threshold in minutes. */
  autoAwayMinutes: z.number().int().min(1).max(240),
  /** The STA statusmsg both away flavors set (F-Chat caps statusmsg at
   * 255 bytes; the wire limit is what matters, so bytes not chars). */
  autoAwayMessage: z
    .string()
    .max(255)
    .refine((value) => utf8ByteLength(value) <= 255, {
      message: "away message exceeds 255 bytes",
    }),
  /** Restore the previous status when activity resumes. */
  autoAwayClearOnReturn: z.boolean(),
  /** Server-side: away after N minutes with zero gateway subscribers,
   * cleared on the next attach. Opt-in (decisions.md §10). */
  detachedAwayEnabled: z.boolean(),
  detachedAwayMinutes: z.number().int().min(1).max(1440),
  /** Desktop notifications (M5 step 8) — off until the user opts in and
   * grants the browser permission. */
  desktopNotifyMentions: z.boolean(),
  desktopNotifyPms: z.boolean(),
  /** Off = notifications show the sender only, never the message body
   * (privacy toggle, decisions.md §10). */
  notifyShowContent: z.boolean(),
  /** Desktop notifications for website events pushed over RTB — new notes
   * and friend requests (M6 step 9, feature-parity audit decision 3). The
   * notice strip shows them regardless. */
  desktopNotifyNotes: z.boolean(),
  /** Mute overrides — alerts only (chime, title flash, desktop
   * notifications); badges and tint still accrue (decisions.md §10).
   * Patches replace the whole array. */
  mutedIdentityIds: z.array(z.uuid()).max(64),
  mutedConvIds: z.array(z.uuid()).max(500),
  /** Never show roleplay ads (LRP) — the account-wide default every channel
   * inherits. Hidden ads neither render nor count as unread. */
  hideAds: z.boolean(),
  /** Per-channel override of hideAds, keyed by lowercased channel key.
   * Absent key = inherit the global default. Patches replace the whole
   * record (same convention as the muted lists). */
  channelAdVisibility: z
    .record(z.string().min(1).max(128), z.enum(["show", "hide"]))
    .refine((value) => Object.keys(value).length <= 500, {
      message: "too many channel overrides",
    }),
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
  showJoinPartQuit: false,
  eiconDisplay: "inline",
  animateEicons: true,
  eiconFavorites: [],
  eiconRecents: [],
  eiconSearchEnabled: false,
  highlightOwnNick: true,
  highlightSound: false,
  highlightFlashTitle: true,
  highlightBump: false,
  highlightTint: "accent",
  autoAwayEnabled: false,
  autoAwayMinutes: 10,
  autoAwayMessage: "",
  autoAwayClearOnReturn: true,
  detachedAwayEnabled: false,
  detachedAwayMinutes: 30,
  desktopNotifyMentions: false,
  desktopNotifyPms: false,
  notifyShowContent: true,
  desktopNotifyNotes: false,
  mutedIdentityIds: [],
  mutedConvIds: [],
  hideAds: false,
  channelAdVisibility: {},
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
