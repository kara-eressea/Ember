// Sidebar section ordering (M5 "bump to top" when-highlighted action):
// with the pref on, rows a live mention touched float to the top, most
// recent first; everything else keeps the plain alphabetical order. The
// bump stamps are volatile client state — a reload starts alphabetical.

export function orderRows<T>(
  rows: readonly T[],
  label: (row: T) => string,
  highlightedAt: (row: T) => number,
  bumpOnHighlight: boolean,
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
 * store's problem, this just renders whatever flag it holds.
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

/** A row's DM activity: the highlight stamp, plus the newest message id as
 * the tiebreaker for conversations no highlight ever stamped. */
export interface RowActivity {
  highlightedAt: number;
  newestMessageId: number;
}

/**
 * Activity bump for the people sections (#462): rows carrying unread DM
 * traffic float to the top of their section, most recent first; everything
 * else keeps the order it arrived in (presence groups + manual order). Same
 * instinct as the Direct-messages bump above, extended to Friends/Bookmarks
 * because one-row-per-character (#290) leaves the social row as the only
 * surface a friend's unread has. Presence deliberately does not gate it — an
 * offline friend who just wrote outranks idle online ones, consistent with
 * unread already overriding the offline filter (#329).
 *
 * `activity` returns undefined for a row with nothing unread. highlightedAt
 * leads (a live highlight is the strongest signal, and it is what the DM bump
 * sorts on) but is 0 unless the bump pref stamped it, so newestMessageId —
 * monotonic across conversations — decides the rest instead of leaving the
 * order to jitter.
 */
export function bumpUnread<T>(
  rows: readonly T[],
  activity: (row: T) => RowActivity | undefined,
): T[] {
  return rows
    .map((row, index) => ({ row, index, activity: activity(row) }))
    .sort((a, b) => {
      if ((a.activity === undefined) !== (b.activity === undefined)) {
        return a.activity === undefined ? 1 : -1;
      }
      if (a.activity && b.activity) {
        const byHighlight = b.activity.highlightedAt - a.activity.highlightedAt;
        if (byHighlight !== 0) {
          return byHighlight;
        }
        const byMessage =
          b.activity.newestMessageId - a.activity.newestMessageId;
        if (byMessage !== 0) {
          return byMessage;
        }
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}
