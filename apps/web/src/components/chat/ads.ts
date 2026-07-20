// Channel-view resolution (M10, replaces the M6 hideAds pair): every
// channel inherits adViewDefault; channelAdView carries per-channel
// overrides from the header's Chat/Ads/Both selector (keyed by lowercased
// channel key). "chat" hides ad rows, "ads" hides chat rows, "both" shows
// everything — filtered rows stay persisted, and ads never count toward
// unread in any view. Sending is unaffected.

import type { UserPrefs } from "@emberchat/protocol";

export type AdView = "chat" | "ads" | "both";

export function adViewFor(
  prefs: Pick<UserPrefs, "adViewDefault" | "channelAdView">,
  channelKey: string | undefined,
): AdView {
  if (channelKey !== undefined) {
    const override = prefs.channelAdView[channelKey.toLowerCase()];
    if (override !== undefined) {
      return override;
    }
  }
  return prefs.adViewDefault;
}

/** The patch that sets one channel's view. Prunes entries that restate the
 * global default, so the record only holds real exceptions (capped at
 * 500 keys). */
export function setChannelAdView(
  prefs: Pick<UserPrefs, "adViewDefault" | "channelAdView">,
  channelKey: string,
  view: AdView,
): Pick<UserPrefs, "channelAdView"> {
  const key = channelKey.toLowerCase();
  const next: Record<string, AdView> = { ...prefs.channelAdView };
  if (view === prefs.adViewDefault) {
    delete next[key];
  } else {
    next[key] = view;
  }
  return { channelAdView: next };
}

/** Whether a message kind renders under a view. Only chat and ad rows are
 * filtered — system lines, rolls and everything else always show. */
export function viewShows(view: AdView, kind: string): boolean {
  if (view === "chat") {
    return kind !== "lrp";
  }
  if (view === "ads") {
    return kind !== "msg";
  }
  return true;
}
