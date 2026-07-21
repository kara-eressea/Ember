// Paging state for the eicon gallery browser (#239). The server hands back
// pages of the full index in index order plus a running total; the browser
// appends them, de-dupes defensively (a mid-scroll index refresh could
// shift things), and tracks whether more remain.

export interface GalleryState {
  names: string[];
  total: number;
  /** Next offset to request. */
  offset: number;
}

export const emptyGallery: GalleryState = { names: [], total: 0, offset: 0 };

/** Fold one fetched page into the accumulated gallery state. */
export function appendPage(
  state: GalleryState,
  page: { names: string[]; total: number },
): GalleryState {
  const seen = new Set(state.names);
  const merged = [...state.names];
  for (const name of page.names) {
    if (!seen.has(name)) {
      seen.add(name);
      merged.push(name);
    }
  }
  return {
    names: merged,
    total: page.total,
    offset: state.offset + page.names.length,
  };
}

/** More pages remain when we hold fewer names than the reported total and
 * the last page actually advanced the cursor (a zero-length page ends it). */
export function hasMore(state: GalleryState): boolean {
  return state.names.length < state.total;
}
