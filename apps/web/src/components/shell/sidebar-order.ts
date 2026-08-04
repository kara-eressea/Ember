// Sidebar section ordering. Two independent mechanisms live here:
//
//   * `orderRows` — the Channels section: alphabetical, or with the M5
//     "bump to top" when-highlighted pref on, rows a live mention touched
//     float above it, most recent first. The bump stamps are volatile client
//     state, so a reload starts alphabetical.
//   * `orderSocial` + `orderByActivity` — the people sections, whose base
//     sort is recent DM activity (#515).

/**
 * Channels ordering: alphabetical by label, with the optional highlight bump
 * (M5) floating recently-mentioned rows above it. `highlightedAt`/`bump` are
 * omitted by callers that only want the alphabetical base — the DM section
 * takes its recency from `orderByActivity` instead (#515).
 */
export function orderRows<T>(
  rows: readonly T[],
  label: (row: T) => string,
  highlightedAt: (row: T) => number = () => 0,
  bumpOnHighlight = false,
): T[] {
  return [...rows].sort((a, b) => {
    if (bumpOnHighlight) {
      const byBump = highlightedAt(b) - highlightedAt(a);
      if (byBump !== 0) {
        return byBump;
      }
    }
    return label(a).localeCompare(label(b));
  });
}

/**
 * One row per character (#290, reversing #227/#242's direction): the
 * lowercased set of characters who are friends or bookmarks. A partner in
 * this set keeps their home row under Friends/Bookmarks — that row carries
 * the DM's unread badge, active anchor, and open-on-click — so the Direct
 * Messages section omits them, listing only partners who are neither friend
 * nor bookmark. F-Chat resolves names case-insensitively, so membership is
 * tested lowercased.
 */
export function socialNameSet(names: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const name of names) {
    set.add(name.toLowerCase());
  }
  return set;
}

/**
 * Friends/Bookmarks ordering (#164): online characters first, alphabetical
 * within each presence group. Pure grouping — presence correctness is the
 * store's problem, this just renders whatever flag it holds. Since #515 this
 * is the *tail* order: rows with DM history sort above it by recency.
 */
export function orderSocial<T>(
  rows: readonly T[],
  name: (row: T) => string,
  online: (row: T) => boolean,
): T[] {
  return [...rows].sort((a, b) => {
    const byPresence = Number(online(b)) - Number(online(a));
    if (byPresence !== 0) {
      return byPresence;
    }
    return name(a).localeCompare(name(b));
  });
}

/**
 * The people sections' base sort (#515): rows with DM history first, most
 * recent message either direction at the top; rows with none keep the order
 * they arrived in (presence groups + alphabetical from `orderSocial`, plain
 * alphabetical for Direct messages) as the tail.
 *
 * `activity` is the conversation's newest message id, 0 for a row with no DM
 * — one global server-assigned sequence, so it orders conversations against
 * each other without a clock and identically on every attached device.
 *
 * This replaces the #462/#463 unread float, which lifted a row only while it
 * carried unread and dropped it back to its alphabetical seat the moment it
 * was read — the person you were mid-conversation with teleported away as you
 * read them. An unread row is recently-active by construction, so the float
 * is subsumed: it needed no special case, only a base sort that remembers.
 * Presence deliberately does not gate this — an offline friend who wrote an
 * hour ago outranks idle online ones, consistent with unread already
 * overriding the offline filter (#329).
 *
 * Stable: rows tied at 0 (the whole no-history tail) keep their incoming
 * order. Ids are unique, so active rows never tie.
 */
export function orderByActivity<T>(
  rows: readonly T[],
  activity: (row: T) => number,
): T[] {
  return rows
    .map((row, index) => ({ row, index, activity: activity(row) }))
    .sort((a, b) => {
      const byActivity = b.activity - a.activity;
      return byActivity !== 0 ? byActivity : a.index - b.index;
    })
    .map((entry) => entry.row);
}
