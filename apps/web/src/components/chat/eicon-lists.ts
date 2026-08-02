// Eicon favourite/block list arithmetic, shared by the right-click menu
// (EiconContextMenu), the picker's ☆, and the Appearance pane's review
// lists. Names are compared case-insensitively — the server's eicon index
// keys on `name.toLowerCase()` (modules/eicons/index-service.ts) and
// `[eicon]Sparkle[/eicon]` and `[eicon]sparkle[/eicon]` are the same image.
// The stored entry keeps the casing the user acted on, which is what the
// review lists show.

/** Schema caps (prefs.ts). Favourites drop the oldest at the cap — losing an
 * old shortcut is harmless; blocks refuse instead, since silently dropping
 * one would put an image back on screen the user asked never to see. */
export const EICON_FAVORITES_CAP = 100;
export const EICON_BLOCKED_CAP = 200;

export function hasEicon(list: readonly string[], name: string): boolean {
  const needle = name.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === needle);
}

export function withoutEicon(list: readonly string[], name: string): string[] {
  const needle = name.toLowerCase();
  return list.filter((entry) => entry.toLowerCase() !== needle);
}

/** Append (or move to the end), never duplicating a differently-cased entry. */
export function withEicon(list: readonly string[], name: string): string[] {
  return [...withoutEicon(list, name), name];
}

/** Toggle into the favourites list, trimming the oldest entries so the patch
 * always clears the schema cap. */
export function toggleEiconFavorite(
  list: readonly string[],
  name: string,
): string[] {
  if (hasEicon(list, name)) {
    return withoutEicon(list, name);
  }
  const next = withEicon(list, name);
  return next.slice(Math.max(0, next.length - EICON_FAVORITES_CAP));
}
