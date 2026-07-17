// Popover anchoring & clamping (COMPONENTS-profile-viewer.md §13): pure
// placement math for the mini profile card and any future click-popover
// (eicon picker). Preferred below-start, flip above when it overflows,
// clamp into the viewport with an 8px margin, cap height so the body
// scrolls instead of the card leaving the viewport.

import type { CardAnchor } from "../../stores/profile.js";

export const POPOVER_GAP = 6;
export const POPOVER_MARGIN = 8;

export interface PopoverPlacement {
  top: number;
  left: number;
  /** Card height cap — the body scrolls beyond it (§13 max size). */
  maxHeight: number;
  placement: "below" | "above";
}

export function placePopover(
  anchor: CardAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): PopoverPlacement {
  const height = Math.min(size.height, viewport.height - 2 * POPOVER_MARGIN);
  const fitsBelow = anchor.bottom + POPOVER_GAP + height <= viewport.height;
  const fitsAbove = anchor.top - POPOVER_GAP - height >= 0;
  // Prefer below; flip when only above fits; if neither fully fits, pick
  // whichever side has more room (the clamp keeps it on screen).
  const below =
    fitsBelow || (!fitsAbove && viewport.height - anchor.bottom >= anchor.top);
  const rawTop = below
    ? anchor.bottom + POPOVER_GAP
    : anchor.top - POPOVER_GAP - height;
  return {
    top: clamp(
      rawTop,
      POPOVER_MARGIN,
      viewport.height - height - POPOVER_MARGIN,
    ),
    left: clamp(
      anchor.left,
      POPOVER_MARGIN,
      viewport.width - size.width - POPOVER_MARGIN,
    ),
    maxHeight: height,
    placement: below ? "below" : "above",
  };
}

/** Horizontal-first placement for the LinkPreview panel
 * (COMPONENTS-link-preview-eicon.md §2): float in the gutter to the
 * right of the anchor, flip to the left when the right can't fit, clamp
 * into the viewport with the same 8px margin. */
export function placeBeside(
  anchor: CardAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: "right" | "left" } {
  const fitsRight =
    anchor.right + POPOVER_GAP + size.width + POPOVER_MARGIN <= viewport.width;
  const fitsLeft = anchor.left - POPOVER_GAP - size.width >= POPOVER_MARGIN;
  const right = fitsRight || !fitsLeft;
  const rawLeft = right
    ? anchor.right + POPOVER_GAP
    : anchor.left - POPOVER_GAP - size.width;
  return {
    top: clamp(
      anchor.top,
      POPOVER_MARGIN,
      viewport.height - size.height - POPOVER_MARGIN,
    ),
    left: clamp(
      rawLeft,
      POPOVER_MARGIN,
      viewport.width - size.width - POPOVER_MARGIN,
    ),
    placement: right ? "right" : "left",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
