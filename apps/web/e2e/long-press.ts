// A finger that goes down, stays down, and lifts (MP2 §1, #376).
//
// CDP rather than Playwright's touchscreen API, which only taps:
// `Input.dispatchTouchEvent` is the only way to put a finger down, leave it
// there past a threshold, and lift it. Which is also what makes the drag case
// meaningful — the same primitive, with movement in the middle.
//
// Shared because the third copy is where a copied helper becomes a rule: the
// long-press, target-sweep and sheet specs all need exactly this gesture, and
// a hold threshold that drifts out of step with `useLongPress`'s in one of
// them would show up as a spec that passes by never recognizing anything.

import type { CDPSession, Locator, Page } from "@playwright/test";
import { settleAnimations } from "./touch-targets.js";

/** Past useLongPress's LONG_PRESS_MS (450) with room for a slow frame. */
export const HOLD_MS = 800;

/**
 * The middle of a locator, in viewport coordinates — where a finger goes.
 *
 * Waits for the shell's animations first, because a finger cannot be put on a
 * moving element and `toBeVisible()` is happy long before an element has
 * arrived: measured mid-slide, a row in the member overlay reported
 * `x: 326, width: 311` on a 393px screen, so the "centre" of it was 88px off
 * the right edge of the phone and every event in the gesture landed on the
 * backdrop instead. Nothing failed — the press simply did not happen, which is
 * indistinguishable from a row that forgot to claim one. Same reason the
 * target sweep settles before it measures (touch-targets.ts).
 */
export async function centreOf(
  locator: Locator,
): Promise<{ x: number; y: number }> {
  await settleAnimations(locator.page());
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("the element has no box to press");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Put a finger down, hold it past the threshold, lift it. */
export async function longPress(
  cdp: CDPSession,
  page: Page,
  locator: Locator,
): Promise<void> {
  const { x, y } = await centreOf(locator);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await page.waitForTimeout(HOLD_MS);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

/**
 * A finger that goes down, wanders past the slop radius the way a scroll does,
 * and only then lifts — long enough that a recognizer which ignored the
 * movement would have fired twice over.
 */
export async function slowDrag(
  cdp: CDPSession,
  page: Page,
  locator: Locator,
): Promise<void> {
  const { x, y } = await centreOf(locator);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 6; step += 1) {
    await page.waitForTimeout(120);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - step * 12 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}
