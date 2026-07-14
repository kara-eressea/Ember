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
