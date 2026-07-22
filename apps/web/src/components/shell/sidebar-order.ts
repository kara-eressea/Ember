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
