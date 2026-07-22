// Recently-viewed rail collapse preference (issue #279): an avatars-only
// compact mode for the profile viewer's history rail. Mirrored to
// localStorage so the choice survives reloads — the same shape the theme and
// DM-sidebar keys use. Until the user picks explicitly, the effective state
// defaults to collapsed on the narrow layout and expanded otherwise, so the
// rail never crowds a small window out of the box.

import { useState } from "react";
import { useIsNarrow } from "./dm-sidebar.js";

/** The single stored preference key. Absent = no explicit choice yet. */
export const RAIL_COLLAPSE_KEY = "eb.profileRail.collapsed";

/** Read the stored choice, or `undefined` when the user hasn't set one.
 * Tolerant of a poisoned or absent value. */
export function savedRailCollapsed(): boolean | undefined {
  try {
    const stored = localStorage.getItem(RAIL_COLLAPSE_KEY);
    if (stored === null) {
      return undefined;
    }
    return stored === "1" || stored === "true";
  } catch {
    return undefined;
  }
}

/** Persist the collapse choice. Swallows storage failures (private mode,
 * quota) — the in-memory state stays authoritative for the session. */
export function persistRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    // Best-effort: the pref just won't survive a reload.
  }
}

/** Effective collapse state + a toggle. The stored preference wins when set;
 * otherwise it defaults to the narrow layout (collapsed on small windows).
 * Toggling records an explicit preference that then holds across layouts. */
export function useRailCollapsed(): [boolean, () => void] {
  const narrow = useIsNarrow();
  const [stored, setStored] = useState<boolean | undefined>(() =>
    savedRailCollapsed(),
  );
  // Follow the layout default only while no explicit choice exists.
  const collapsed = stored ?? narrow;
  function toggle() {
    const next = !collapsed;
    persistRailCollapsed(next);
    setStored(next);
  }
  return [collapsed, toggle];
}
