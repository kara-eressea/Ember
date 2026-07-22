// Resizable shell columns (issue #292): the left sidebar and the right column
// (member list / DM profile share the 232px slot) can be dragged wider or
// narrower, within sensible bounds, and the chosen width is mirrored to
// localStorage the same way the DM sidebar (eb.dmSidebar.open) and theme keys
// do — a per-device layout-fit choice, not synced account state. The docked
// grid columns read these widths through CSS variables; the narrow overlay
// drawers keep their own fixed sizing and are never touched here.

/** Column identity — each persists independently. */
export type ResizableColumn = "left" | "right";

/** Design-system defaults (COMPONENTS.md §Layout): the shell's base column
 * widths. A double-click on a handle resets to these. */
export const LEFT_DEFAULT_WIDTH = 244;
export const RIGHT_DEFAULT_WIDTH = 232;

/** Shared drag bounds — narrow enough to stay usable, wide enough to read a
 * long channel name or a DM hero without dominating the window. */
export const MIN_COLUMN_WIDTH = 180;
export const MAX_COLUMN_WIDTH = 400;

const STORAGE_KEYS: Record<ResizableColumn, string> = {
  left: "eb.sidebar.leftWidth",
  right: "eb.sidebar.rightWidth",
};

const DEFAULT_WIDTHS: Record<ResizableColumn, number> = {
  left: LEFT_DEFAULT_WIDTH,
  right: RIGHT_DEFAULT_WIDTH,
};

/** The CSS custom properties the shell grid reads for each column width. */
export const WIDTH_VARS: Record<ResizableColumn, string> = {
  left: "--eb-left-width",
  right: "--eb-right-width",
};

/** Clamp a candidate width into [MIN, MAX], rounding to a whole pixel. A
 * non-finite value (NaN from a poisoned store, Infinity) falls back to the
 * column's default so a bad read never wedges the layout. */
export function clampColumnWidth(
  width: number,
  column: ResizableColumn,
): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_WIDTHS[column];
  }
  return Math.min(
    MAX_COLUMN_WIDTH,
    Math.max(MIN_COLUMN_WIDTH, Math.round(width)),
  );
}

/** Read the stored width for a column, clamped. Defaults to the design-system
 * base when nothing is stored. Tolerant of a poisoned value and of storage
 * that throws (private mode). */
export function savedColumnWidth(column: ResizableColumn): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS[column]);
    if (stored === null) {
      return DEFAULT_WIDTHS[column];
    }
    const parsed = Number.parseInt(stored, 10);
    if (Number.isNaN(parsed)) {
      return DEFAULT_WIDTHS[column];
    }
    return clampColumnWidth(parsed, column);
  } catch {
    return DEFAULT_WIDTHS[column];
  }
}

/** Persist a column width (clamped first). Swallows storage failures — the
 * in-memory state stays authoritative for the session. */
export function persistColumnWidth(
  column: ResizableColumn,
  width: number,
): void {
  try {
    localStorage.setItem(
      STORAGE_KEYS[column],
      String(clampColumnWidth(width, column)),
    );
  } catch {
    // Best-effort: the pref just won't survive a reload.
  }
}
