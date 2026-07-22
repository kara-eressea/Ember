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

/** Base (neutral) themes: "slate" is the original Slate Cozy set,
 * "charcoal" the dimmer near-black, "parchment" the M9 light variant
 * (the token pass deferred from M5, decisions.md §10). */
export const BASE_THEME_IDS = ["slate", "charcoal", "parchment"] as const;
export type BaseThemeId = (typeof BASE_THEME_IDS)[number];

export const DENSITIES = ["cozy", "compact"] as const;
export const FONT_SIZES = ["s", "m", "l"] as const;
/** Interface (chrome) type ramp — sidebar, headers, menus, prefs — S/M/L,
 * independent of the message-body FONT_SIZES above. Mirrored by the web
 * theme's UI_FONT_PX. */
export const UI_FONT_SIZES = ["s", "m", "l"] as const;
/** Whole-interface scale steps (percent), browser-zoom style. The UI offers
 * exactly these; the schema validates the [min, max] band so a future step
 * doesn't reject an older stored value. Default 100. */
export const UI_SCALE_STEPS = [80, 90, 100, 110, 125, 150] as const;
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 150;
/** `[12:04]` · `[12:04:33]` · hidden. */
export const TIMESTAMP_FORMATS = ["time", "seconds", "off"] as const;
/** Inline images vs name chips with a hover preview (decisions.md §8). */
export const EICON_DISPLAY_MODES = ["inline", "name"] as const;
/** Link previews (M8, decisions.md §14): click = a plain click on a
 * previewable media link opens the floating preview (Ctrl/Cmd/middle
 * click still navigates); hover = ~250ms hover opens it; off = links are
 * plain links. */
export const LINK_PREVIEW_MODES = ["off", "hover", "click"] as const;

/** Matches the eicon-name charset the URL builder accepts (web avatar.ts). */
export const EICON_NAME = /^[a-zA-Z0-9_\-\s.]+$/;

/** A bare hostname (no scheme, port, or path): dot-separated DNS labels, at
 * least two, each 1–63 chars of alnum/hyphen not starting or ending with a
 * hyphen. The image-preview allowlist stores these; the UI normalizes input
 * (strips scheme/path/port) before validating against this. */
export const IMAGE_PREVIEW_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Default inline-image-preview allowlist: the known-good direct-image and
 * rewrite hosts. Previews only auto-load for a host on the user's list;
 * everything else stays a plain link (issue #215). Both apex and the `i.`/
 * `cdn.`/`media.` subdomains our rewrites can land on are listed so the
 * conservative default "just works" without relying on subdomain matching. */
export const DEFAULT_IMAGE_PREVIEW_HOSTS = [
  "static.f-list.net",
  "imgur.com",
  "i.imgur.com",
  "gyazo.com",
  "i.gyazo.com",
  "pbs.twimg.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "xariah.net",
] as const;

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
  /** Interface (chrome) type size — scales sidebar/header/menu/prefs text,
   * independent of the message-body `fontSize` above (issue #319). */
  uiFontSize: z.enum(UI_FONT_SIZES),
  /** Whole-interface scale, percent (browser-zoom style, issue #319). Stored
   * as an integer in [UI_SCALE_MIN, UI_SCALE_MAX]; the UI steps through
   * UI_SCALE_STEPS. Default 100. */
  uiScale: z.number().int().min(UI_SCALE_MIN).max(UI_SCALE_MAX),
  /** Colorblind-friendly status colors + shape-coded presence dots (M9):
   * ok/warn/danger move to an Okabe–Ito-derived set and the away/offline
   * dots gain distinct shapes so hue is never the only signal. */
  colorblindMode: z.boolean(),
  /** Timestamp rendering in the log. */
  timestampFormat: z.enum(TIMESTAMP_FORMATS),
  use24HourClock: z.boolean(),
  /** Hide the sender on back-to-back messages from the same person. */
  groupConsecutive: z.boolean(),
  /** Fixed timestamp/name columns so message text lines up (M1 UAT). */
  alignedColumns: z.boolean(),
  /** Render join/part/quit lines in channel logs (live-only lines). */
  showJoinPartQuit: z.boolean(),
  /** Composer input that styles Markdown as you type (#226): **bold**
   * renders bold in place, markers stay visible but dimmed. Off = the
   * classic plain-text input with the separate preview panel. */
  inlineComposer: z.boolean(),
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
  /** Floating media previews for links in the log (M8). Loading a preview
   * hotlinks the image host directly from the browser (IP disclosure —
   * same model as avatars/eicons). */
  linkPreviewMode: z.enum(LINK_PREVIEW_MODES),
  /** Per-host allowlist for inline image previews (#215): a preview only
   * ever auto-loads when the media host is on this list — every other host
   * stays a plain link. Defaults to DEFAULT_IMAGE_PREVIEW_HOSTS; the user
   * adds/removes hosts in Preferences. Patches replace the whole array. */
  imagePreviewHosts: z
    .array(z.string().min(1).max(253).regex(IMAGE_PREVIEW_HOST))
    .max(100),
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
  /** Recent status messages (M9), most-recent-first, offered as one-click
   * chips in the status editor. Written on every successful non-empty STA;
   * patches replace the whole array (the recents convention). */
  statusMessageRecents: z.array(z.string().min(1).max(255)).max(20),
  /** Hide offline friends/bookmarks in the channel list (default on).
   * Older clients simply ignore the stored key (resolvePrefs drops
   * unknowns) and keep showing offline rows. */
  hideOfflineCharacters: z.boolean(),
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
  /** Saved character searches (M10) — filter definitions only, synced like
   * every pref; each device keeps its own last-run name set for the "N new"
   * diff (result lists are too heavy for the prefs fan-out). Patches
   * replace the whole array. */
  savedSearches: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(60),
        kinks: z.array(z.string().min(1).max(16)).min(1).max(64),
        genders: z.array(z.string().min(1).max(32)).max(16).optional(),
        orientations: z.array(z.string().min(1).max(32)).max(16).optional(),
        languages: z.array(z.string().min(1).max(32)).max(16).optional(),
        furryprefs: z.array(z.string().min(1).max(64)).max(8).optional(),
        roles: z.array(z.string().min(1).max(32)).max(8).optional(),
      }),
    )
    .max(12),
  /** Channel view default (M10, replaces M6's hideAds boolean): what a
   * channel shows unless overridden — "both" everything, "chat" hides ad
   * rows, "ads" hides chat rows. Ads never count toward unread regardless
   * of view. */
  adViewDefault: z.enum(["chat", "ads", "both"]),
  /** Per-channel view override (the header's Chat/Ads/Both selector),
   * keyed by lowercased channel key. Absent key = inherit the default;
   * entries restating the default are pruned. Patches replace the whole
   * record (same convention as the muted lists). */
  channelAdView: z
    .record(z.string().min(1).max(128), z.enum(["chat", "ads", "both"]))
    .refine((value) => Object.keys(value).length <= 500, {
      message: "too many channel overrides",
    }),
} as const;

/** The M6 shapes the M10 tri-state replaced — read once by resolvePrefs to
 * migrate stored documents; never written again. */
const legacyHideAds = z.boolean();
const legacyChannelAdVisibility = z.record(
  z.string().min(1).max(128),
  z.enum(["show", "hide"]),
);

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
  uiFontSize: "m",
  uiScale: 100,
  colorblindMode: false,
  timestampFormat: "time",
  use24HourClock: true,
  groupConsecutive: false,
  alignedColumns: false,
  showJoinPartQuit: false,
  inlineComposer: false,
  eiconDisplay: "inline",
  animateEicons: true,
  eiconFavorites: [],
  eiconRecents: [],
  eiconSearchEnabled: false,
  linkPreviewMode: "click",
  imagePreviewHosts: [...DEFAULT_IMAGE_PREVIEW_HOSTS],
  highlightOwnNick: true,
  highlightSound: false,
  highlightFlashTitle: true,
  highlightBump: false,
  highlightTint: "accent",
  autoAwayEnabled: false,
  autoAwayMinutes: 10,
  autoAwayMessage: "",
  autoAwayClearOnReturn: true,
  statusMessageRecents: [],
  hideOfflineCharacters: true,
  detachedAwayEnabled: false,
  detachedAwayMinutes: 30,
  desktopNotifyMentions: false,
  desktopNotifyPms: false,
  notifyShowContent: true,
  desktopNotifyNotes: false,
  mutedIdentityIds: [],
  mutedConvIds: [],
  savedSearches: [],
  adViewDefault: "both",
  channelAdView: {},
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
  // M6 → M10 migration: a stored document from before the tri-state view
  // carries hideAds/channelAdVisibility. Map them onto the new fields the
  // first time — once any client patches the new keys, they win.
  if (source["adViewDefault"] === undefined) {
    const legacy = legacyHideAds.safeParse(source["hideAds"]);
    if (legacy.success && legacy.data) {
      resolved["adViewDefault"] = "chat";
    }
  }
  if (source["channelAdView"] === undefined) {
    const legacy = legacyChannelAdVisibility.safeParse(
      source["channelAdVisibility"],
    );
    if (legacy.success && Object.keys(legacy.data).length > 0) {
      resolved["channelAdView"] = Object.fromEntries(
        Object.entries(legacy.data).map(([key, value]) => [
          key,
          value === "hide" ? "chat" : "both",
        ]),
      );
    }
  }
  return resolved as UserPrefs;
}
