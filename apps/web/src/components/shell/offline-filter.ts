// Sidebar offline-hiding for people rows (#329). The three people sections —
// Friends, Bookmarks, Direct messages — each hide their offline rows behind
// an independent synced "show offline" pref, seeded from the old global
// hideOfflineCharacters (see protocol resolvePrefs). Channels are never
// presence-filtered, so they are not part of this set.
//
// Offline hiding also covers DM-carrying rows (a friend/bookmark with an open
// DM, or a plain Direct-messages partner), with three always-show exemptions
// so an active conversation is never stranded: a pinned row, a row with
// unread activity, and the currently open conversation always show.

import type { UserPrefs } from "@emberchat/protocol";

/** The people sections offline-hiding applies to (a subset of the collapse
 * sections — "channels" is excluded). */
export const OFFLINE_SECTIONS = ["friends", "bookmarks", "dms"] as const;
export type OfflineSection = (typeof OFFLINE_SECTIONS)[number];

/** The synced pref key that governs each section's offline visibility. */
export const SHOW_OFFLINE_PREF = {
  friends: "showOfflineFriends",
  bookmarks: "showOfflineBookmarks",
  dms: "showOfflineDms",
} as const satisfies Record<OfflineSection, keyof UserPrefs>;

/** Whether the given section is currently showing its offline rows. */
export function showOfflineFor(
  prefs: Pick<UserPrefs, (typeof SHOW_OFFLINE_PREF)[OfflineSection]>,
  section: OfflineSection,
): boolean {
  return prefs[SHOW_OFFLINE_PREF[section]];
}

/** A single people row's inputs to the keep/hide decision. */
export interface RowVisibility {
  /** The partner/character is online. Online rows always show. */
  online: boolean;
  /** The section's "show offline" pref — when on, offline rows stay too. */
  showOffline: boolean;
  /** DM-conversation pin — an always-show exemption. */
  pinned?: boolean;
  /** Unread count on the row's DM — any unread is an always-show exemption. */
  unread?: number;
  /** The row's DM is the conversation on screen — an always-show exemption. */
  active?: boolean;
}

/**
 * Keep a people row when it is online, when its section shows offline rows,
 * or when any of the three always-show exemptions applies (pinned, unread,
 * or the currently open conversation). Plain social rows with no DM pass
 * `pinned`/`unread`/`active` as absent, so they hide purely on presence and
 * the section pref — exactly like before #329.
 */
export function keepRow({
  online,
  showOffline,
  pinned = false,
  unread = 0,
  active = false,
}: RowVisibility): boolean {
  return online || showOffline || pinned || unread > 0 || active;
}
