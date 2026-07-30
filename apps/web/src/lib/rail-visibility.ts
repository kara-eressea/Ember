// Identity-rail visibility (issue #346): the rail is wasted space with a single
// connected character, so clicking your own avatar (the MeBar) hides it. The
// choice is a per-device layout-fit preference, mirrored to localStorage the
// same way the resizable columns (eb.sidebar.leftWidth) and the DM sidebar
// (eb.dmSidebar.open) are — never synced account state. The docked grid reads
// the choice through a CSS variable; the value is read synchronously at store
// init so the shell paints in its final shape with no boot flash.

const STORAGE_KEY = "eb.rail.hidden";

/** Read the stored hide preference. Tolerant of storage that throws (private
 * mode) — defaults to visible. */
export function savedRailHidden(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the hide preference. Swallows storage failures — the in-memory
 * store stays authoritative for the session. */
export function persistRailHidden(hidden: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
  } catch {
    // Best-effort: the pref just won't survive a reload.
  }
}

/**
 * The rail is actually hidden only when the user hid it AND a single identity
 * is connected. A second identity forces it back into view so a
 * newly-connected character is never lost — while the stored preference
 * survives untouched for when the user drops back to one identity.
 */
export function railHidden(pref: boolean, identityCount: number): boolean {
  return pref && identityCount < 2;
}
