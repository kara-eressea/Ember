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
 * One row per character (#227): the lowercased set of partners who already
 * have an open DM row. Friends/bookmarks in this set are suppressed from the
 * social sections — the character shows only as its DM row, which carries
 * presence (#229), unread, and the active anchor. F-Chat resolves names
 * case-insensitively, so membership is tested lowercased.
 */
export function openDmPartnerSet(partners: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const partner of partners) {
    set.add(partner.toLowerCase());
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
