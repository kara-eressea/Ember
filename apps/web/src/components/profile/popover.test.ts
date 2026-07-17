// §13 placement math: below-start preferred, flip above on overflow, clamp
// into the viewport with the 8px margin, cap height so the body scrolls.

import { describe, expect, it } from "vitest";
import { placeBeside, placePopover } from "./popover.js";

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
