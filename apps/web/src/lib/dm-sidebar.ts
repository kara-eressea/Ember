// DM profile sidebar (issue #170): a single global open preference, mirrored
// to localStorage so the choice survives reloads — the same shape the theme
// keys use (eb.accent, eb.baseTheme). The pref governs the wide-window grid
// column; below the responsive breakpoint the sidebar is a transient overlay
// drawer that always starts closed, so the persisted pref never forces an
// overlay open on a narrow window.

import { useEffect, useState } from "react";

/** Spec §5: the single global preference key. */
export const DM_SIDEBAR_KEY = "eb.dmSidebar.open";

/** The responsive breakpoint (design-system): at or below this the sidebar
 * becomes a right-edge overlay drawer instead of a grid column. */
export const DM_SIDEBAR_NARROW_QUERY = "(max-width: 899px)";

/** Read the stored open preference. Defaults to open (true) — a first-time
 * DM shows the partner beside the conversation. Tolerant of a poisoned or
 * absent value. */
export function savedDmSidebarOpen(): boolean {
  try {
    const stored = localStorage.getItem(DM_SIDEBAR_KEY);
    if (stored === null) {
      return true;
    }
    return stored === "1" || stored === "true";
  } catch {
    return true;
  }
}

/** Persist the open preference. Swallows storage failures (private mode,
 * quota) — the in-memory state is still authoritative for the session. */
export function persistDmSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(DM_SIDEBAR_KEY, open ? "1" : "0");
  } catch {
    // Best-effort: the pref just won't survive a reload.
  }
}

/** True while the viewport is at or below the responsive breakpoint. SSR- and
 * jsdom-safe (returns false when matchMedia is unavailable). */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }
    return window.matchMedia(DM_SIDEBAR_NARROW_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia(DM_SIDEBAR_NARROW_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
    };
    // The initializer already read the current match; the listener carries it
    // forward. (A synchronous setState here would only cover a query flip
    // between render and effect, which the listener also catches.)
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);
  return narrow;
}
