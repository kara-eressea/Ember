// @vitest-environment jsdom
//
// §13 placement math: below-start preferred, flip above on overflow, clamp
// into the viewport with the 8px margin, cap height so the body scrolls.
// jsdom for the `*InWindow` wrappers, which read the live viewport and the
// interface-scale zoom factor off :root.

import { afterEach, describe, expect, it } from "vitest";
import {
  placeAtPoint,
  placeAtPointInWindow,
  placeBeside,
  placeCorner,
  placePopover,
  placePopoverInWindow,
  POPOVER_CORNER_MARGIN,
} from "./popover.js";

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = { width: 300, height: 240 };

describe("placePopover", () => {
  it("prefers below-start: top = anchor.bottom + gap, left = anchor.left", () => {
    const placed = placePopover(
      { top: 100, left: 400, bottom: 120, right: 480 },
      SIZE,
      VIEWPORT,
    );
    expect(placed).toMatchObject({ top: 126, left: 400, placement: "below" });
  });

  it("flips above when the card would overflow the bottom edge", () => {
    const placed = placePopover(
      { top: 700, left: 400, bottom: 720, right: 480 },
      SIZE,
      VIEWPORT,
    );
    expect(placed.placement).toBe("above");
    expect(placed.top).toBe(700 - 6 - 240);
  });

  it("clamps the cross axis so the card never leaves the viewport", () => {
    const nearRightEdge = placePopover(
      { top: 100, left: 1200, bottom: 120, right: 1260 },
      SIZE,
      VIEWPORT,
    );
    expect(nearRightEdge.left).toBe(1280 - 300 - 8);
    const nearLeftEdge = placePopover(
      { top: 100, left: 2, bottom: 120, right: 60 },
      SIZE,
      VIEWPORT,
    );
    expect(nearLeftEdge.left).toBe(8);
  });

  it("picks the roomier side and clamps when neither side fully fits", () => {
    const shortViewport = { width: 1280, height: 200 };
    const placed = placePopover(
      { top: 120, left: 400, bottom: 140, right: 480 },
      SIZE,
      shortViewport,
    );
    // More room above (120) than below (60) → above, clamped into view.
    expect(placed.placement).toBe("above");
    expect(placed.top).toBe(8);
  });

  it("caps height at viewport - margins so the body scrolls instead", () => {
    const shortViewport = { width: 1280, height: 200 };
    const placed = placePopover(
      { top: 120, left: 400, bottom: 140, right: 480 },
      SIZE,
      shortViewport,
    );
    expect(placed.maxHeight).toBe(200 - 16);
  });

  // The fit tests and the clamps must agree on the margins, or a "just fits
  // below" anchor is placed below and then clamped back UP over the very
  // name that was clicked.
  it("never claims a below fit the bottom-margin clamp would undo", () => {
    const anchor = { top: 534, left: 400, bottom: 554, right: 480 };
    // 554 + 6 + 240 === 800: flush with the edge, inside the 8px margin.
    const placed = placePopover(anchor, SIZE, VIEWPORT);
    expect(placed.placement).toBe("above");
    expect(placed.top + SIZE.height).toBeLessThanOrEqual(anchor.top - 6);
  });

  it("treats the 8px margin as the boundary above, too", () => {
    const shortViewport = { width: 1280, height: 300 };
    // 254 - 6 - 240 === 8: fits above exactly on the margin.
    const placed = placePopover(
      { top: 254, left: 400, bottom: 274, right: 480 },
      SIZE,
      shortViewport,
    );
    expect(placed).toMatchObject({ placement: "above", top: 8 });
    expect(placed.top + SIZE.height).toBeLessThanOrEqual(254 - 6);
  });
});

describe("placeCorner (docked mini card)", () => {
  it("parks in the bottom-right with the corner margin", () => {
    expect(placeCorner(SIZE, VIEWPORT)).toEqual({
      top: 800 - 240 - POPOVER_CORNER_MARGIN,
      left: 1280 - 300 - POPOVER_CORNER_MARGIN,
      maxHeight: 800 - 2 * POPOVER_CORNER_MARGIN,
    });
  });

  it("caps a card taller than the viewport instead of overflowing", () => {
    const placed = placeCorner({ width: 300, height: 900 }, VIEWPORT);
    expect(placed.top).toBe(POPOVER_CORNER_MARGIN);
    expect(placed.maxHeight).toBe(800 - 2 * POPOVER_CORNER_MARGIN);
  });
});

describe("placeAtPoint (context menus)", () => {
  it("opens at the cursor when there is room", () => {
    expect(
      placeAtPoint({ x: 300, y: 200 }, { width: 220, height: 260 }, VIEWPORT),
    ).toEqual({ top: 200, left: 300 });
  });

  it("pulls the menu back inside both edges", () => {
    expect(
      placeAtPoint({ x: 1270, y: 790 }, { width: 220, height: 260 }, VIEWPORT),
    ).toEqual({ top: 800 - 260 - 8, left: 1280 - 220 - 8 });
  });
});

// #319/#388: the interface-scale pref puts `zoom` on :root. Fixed popovers
// live inside that zoom, so their inline coordinates are scaled again on
// paint while the anchor rect and window.innerWidth/Height are not.
describe("zoom-corrected placement", () => {
  function setViewport(width: number, height: number, zoom?: number) {
    Object.defineProperty(window, "innerWidth", {
      value: width,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: height,
      configurable: true,
    });
    if (zoom !== undefined) {
      document.documentElement.style.setProperty("--eb-ui-zoom", String(zoom));
    }
  }

  afterEach(() => {
    document.documentElement.style.removeProperty("--eb-ui-zoom");
  });

  it("is a plain viewport placement at 100%", () => {
    setViewport(1280, 800, 1);
    expect(
      placePopoverInWindow(
        { top: 100, left: 400, bottom: 120, right: 480 },
        SIZE,
      ),
    ).toMatchObject({ top: 126, left: 400 });
  });

  it("divides the anchor and the viewport by the zoom factor", () => {
    setViewport(1280, 800, 1.25);
    // The trigger's bottom renders at y=260 on screen; inside the zoomed
    // root that is 208, and 208 * 1.25 lands the card back under the name.
    const placed = placePopoverInWindow(
      { top: 240, left: 500, bottom: 260, right: 600 },
      SIZE,
    );
    expect(placed).toMatchObject({ top: 208 + 6, left: 400 });
    // …and the height cap comes from the viewport in that same space
    // (800 / 1.25), not from the raw 800 visual pixels.
    const tall = placePopoverInWindow(
      { top: 240, left: 500, bottom: 260, right: 600 },
      { width: 300, height: 900 },
    );
    expect(tall.maxHeight).toBe(640 - 16);
  });

  it("clamps against the real edges rather than the scaled ones", () => {
    setViewport(1280, 800, 1.25);
    // Bottom-right corner of the *visual* viewport.
    const placed = placePopoverInWindow(
      { top: 760, left: 1240, bottom: 780, right: 1270 },
      SIZE,
    );
    expect(placed.left).toBe(1280 / 1.25 - 300 - 8);
    expect(placed.top + placed.maxHeight).toBeLessThanOrEqual(800 / 1.25 - 8);
  });

  it("corrects cursor coordinates for context menus too", () => {
    setViewport(1280, 800, 1.25);
    expect(
      placeAtPointInWindow({ x: 500, y: 250 }, { width: 220, height: 260 }),
    ).toEqual({ top: 200, left: 400 });
  });
});

describe("placeBeside (link preview, §2)", () => {
  const SIZE = { width: 340, height: 260 };

  it("prefers the right gutter, top-aligned with the anchor", () => {
    const placed = placeBeside(
      { top: 200, left: 300, bottom: 220, right: 420 },
      SIZE,
      VIEWPORT,
    );
    expect(placed).toEqual({ top: 200, left: 426, placement: "right" });
  });

  it("flips left when the right gutter can't fit the panel", () => {
    const placed = placeBeside(
      { top: 200, left: 980, bottom: 220, right: 1100 },
      SIZE,
      VIEWPORT,
    );
    expect(placed.placement).toBe("left");
    expect(placed.left).toBe(980 - 6 - 340);
  });

  it("clamps vertically so the panel never leaves the viewport", () => {
    const placed = placeBeside(
      { top: 700, left: 300, bottom: 720, right: 420 },
      SIZE,
      VIEWPORT,
    );
    expect(placed.top).toBe(800 - 260 - 8);
  });
});
