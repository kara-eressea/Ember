// §13 placement math: below-start preferred, flip above on overflow, clamp
// into the viewport with the 8px margin, cap height so the body scrolls.

import { describe, expect, it } from "vitest";
import { placePopover } from "./popover.js";

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
