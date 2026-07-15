// Ads-visibility resolution (M6): the account-wide hideAds preference is
// what every channel inherits; channelAdVisibility carries the per-channel
// overrides (keyed by lowercased channel key). Hidden ads neither render
// nor bump unread — sending is unaffected.

import type { UserPrefs } from "@emberchat/protocol";

export function adsHidden(
  prefs: Pick<UserPrefs, "hideAds" | "channelAdVisibility">,
  channelKey: string | undefined,
): boolean {
  if (channelKey !== undefined) {
    const override = prefs.channelAdVisibility[channelKey.toLowerCase()];
    if (override !== undefined) {
      return override === "hide";
    }
  }
  return prefs.hideAds;
}

/** The patch that flips one channel's effective visibility. Prunes entries
 * that just restate the global default, so the record only holds real
 * exceptions (it is capped at 500 keys). */
export function toggleChannelAds(
  prefs: Pick<UserPrefs, "hideAds" | "channelAdVisibility">,
  channelKey: string,
): Pick<UserPrefs, "channelAdVisibility"> {
  const key = channelKey.toLowerCase();
  const next: Record<string, "hide" | "show"> = {
    ...prefs.channelAdVisibility,
  };
  const hideNow = !adsHidden(prefs, channelKey);
  if (hideNow === prefs.hideAds) {
    delete next[key];
  } else {
    next[key] = hideNow ? "hide" : "show";
  }
  return { channelAdVisibility: next };
}
