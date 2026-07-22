// Profile-viewer window size (issue #276): the full-screen/expanded choice is
// a device-level UI preference, mirrored to localStorage the same way the DM
// sidebar (eb.dmSidebar.open) and theme keys do — so the *next* profile opened
// starts in whatever mode the user last left the viewer in. Not synced: it's a
// per-device window-fit choice, not account state.

/** The single global preference key (eb.* precedent). */
export const VIEWER_FULLSCREEN_KEY = "eb.profileViewer.fullscreen";

/** Read the stored full-screen preference. Defaults to false (the 900px
 * windowed viewer) when nothing is stored. Tolerant of a poisoned or absent
 * value, and of storage that throws (private mode). */
export function savedViewerFullscreen(): boolean {
  try {
    const stored = localStorage.getItem(VIEWER_FULLSCREEN_KEY);
    if (stored === null) {
      return false;
    }
    return stored === "1" || stored === "true";
  } catch {
    return false;
  }
}

/** Persist the full-screen preference. Swallows storage failures — the
 * in-memory state stays authoritative for the session. */
export function persistViewerFullscreen(fullscreen: boolean): void {
  try {
    localStorage.setItem(VIEWER_FULLSCREEN_KEY, fullscreen ? "1" : "0");
  } catch {
    // Best-effort: the pref just won't survive to the next viewer open.
  }
}
