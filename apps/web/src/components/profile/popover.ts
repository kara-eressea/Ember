// Popover anchoring & clamping (COMPONENTS-profile-viewer.md §13): pure
// placement math for the mini profile card and every other click-popover
// (eicon picker, rate editor, composer toolbar, link preview, context
// menus). Preferred below-start, flip above when it overflows, clamp into
// the viewport with an 8px margin, cap height so the body scrolls instead
// of the card leaving the viewport.
//
// Coordinate spaces (#388 again): the interface-scale pref puts `zoom` on
// :root, and every popover is `position: fixed` INSIDE that zoomed root, so
// the inline top/left we write are scaled once more on paint. Client rects
// (getBoundingClientRect) and window.innerWidth/Height are already in visual
// pixels, while element metrics (offsetWidth, scrollHeight) and inline
// lengths are in the root's own CSS pixels. The math therefore runs entirely
// in root CSS pixels: the `*InWindow` wrappers divide the anchor rect and the
// viewport by the zoom factor, and their result is what the style attribute
// wants. Always place through a wrapper rather than reading `window` at the
// call site.

import { uiZoom } from "../../lib/ui-zoom.js";
import type { CardAnchor } from "../../stores/profile.js";

export const POPOVER_GAP = 6;
export const POPOVER_MARGIN = 8;
/** Docked ("corner") mini-card inset from the viewport edges. */
export const POPOVER_CORNER_MARGIN = 16;

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
  // The fit tests must use the same margins as the clamps below, or a "just
  // fits" anchor is placed and then clamped back over the trigger it was
  // anchored to.
  const fitsBelow =
    anchor.bottom + POPOVER_GAP + height <= viewport.height - POPOVER_MARGIN;
  const fitsAbove = anchor.top - POPOVER_GAP - height >= POPOVER_MARGIN;
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

/** Anchor-free placement for the docked ("corner") mini card: parked in the
 * bottom-right of the viewport, stationary whatever the trigger was. */
export function placeCorner(
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; maxHeight: number } {
  const maxHeight = viewport.height - 2 * POPOVER_CORNER_MARGIN;
  const height = Math.min(size.height, maxHeight);
  return {
    top: Math.max(
      POPOVER_CORNER_MARGIN,
      viewport.height - height - POPOVER_CORNER_MARGIN,
    ),
    left: Math.max(
      POPOVER_CORNER_MARGIN,
      viewport.width - size.width - POPOVER_CORNER_MARGIN,
    ),
    maxHeight,
  };
}

/** Cursor-anchored placement for context menus: open at the pointer, pulled
 * back inside the viewport by the shared margin. */
export function placeAtPoint(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  return {
    top: clamp(
      point.y,
      POPOVER_MARGIN,
      viewport.height - size.height - POPOVER_MARGIN,
    ),
    left: clamp(
      point.x,
      POPOVER_MARGIN,
      viewport.width - size.width - POPOVER_MARGIN,
    ),
  };
}

/** The visual viewport expressed in the zoomed root's CSS pixels. */
export function popoverViewport(): { width: number; height: number } {
  const zoom = uiZoom();
  return { width: window.innerWidth / zoom, height: window.innerHeight / zoom };
}

/** A client rect (visual pixels) expressed in the zoomed root's CSS pixels. */
export function popoverSpace(rect: CardAnchor): CardAnchor {
  const zoom = uiZoom();
  if (zoom === 1) {
    return rect;
  }
  return {
    top: rect.top / zoom,
    left: rect.left / zoom,
    bottom: rect.bottom / zoom,
    right: rect.right / zoom,
  };
}

/** placePopover against the live, zoom-corrected viewport. `size` is in root
 * CSS pixels (offsetWidth/scrollHeight already are). */
export function placePopoverInWindow(
  anchor: CardAnchor,
  size: { width: number; height: number },
): PopoverPlacement {
  return placePopover(popoverSpace(anchor), size, popoverViewport());
}

/** placeBeside against the live, zoom-corrected viewport. */
export function placeBesideInWindow(
  anchor: CardAnchor,
  size: { width: number; height: number },
): { top: number; left: number; placement: "right" | "left" } {
  return placeBeside(popoverSpace(anchor), size, popoverViewport());
}

/** placeAtPoint against the live, zoom-corrected viewport. `point` is a
 * client coordinate (clientX/clientY). */
export function placeAtPointInWindow(
  point: { x: number; y: number },
  size: { width: number; height: number },
): { top: number; left: number } {
  const zoom = uiZoom();
  return placeAtPoint(
    { x: point.x / zoom, y: point.y / zoom },
    size,
    popoverViewport(),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
