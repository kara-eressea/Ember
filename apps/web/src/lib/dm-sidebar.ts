// DM profile sidebar (issue #170): a single global open preference, mirrored
// to localStorage so the choice survives reloads — the same shape the theme
// keys use (eb.accent, eb.baseTheme). The pref governs the grid column on the
// wide tier; below it the sidebar is a transient overlay drawer that always
// starts closed, so the persisted pref never forces an overlay open on a
// narrow window.

import { useLayoutMode } from "./layout-mode.js";

/** Spec §5: the single global preference key. */
export const DM_SIDEBAR_KEY = "eb.dmSidebar.open";

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

/** True on anything narrower than the wide desktop tier — the drawer/overlay
 * side of every "is there room for a second column?" decision. A derivation of
 * the shared tier model (lib/layout-mode.ts): this used to carry its own
 * `(max-width: 899px)` media query, which both drifted from the shell's other
 * breakpoints and read the pre-zoom viewport. SSR- and jsdom-safe by way of
 * useLayoutMode, which defaults to `wide` when the environment can't answer. */
export function useIsNarrow(): boolean {
  return useLayoutMode() !== "wide";
}
