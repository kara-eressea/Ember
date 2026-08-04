// Climbing history must never be fought back toward the tail (#514), on a
// desktop viewport.
//
// The report is a phone one, but the user saw the same thing here, "just less
// pronounced" — and the mechanism is width-independent, so this is a first-class
// repro surface rather than a courtesy pass. What differs is the trigger: on a
// phone the "Jump to newest" pill's own appearance shortened the log and the
// #284 re-stick observer read the shrink as a reason to glue; here it is the
// arrival path, where a message landing while the reader is still inside the
// 120px release hysteresis armed the #372 settle pass and it wrote toward the
// tail underneath them. Both were gated on the held stick intent alone, which
// cannot tell a parked log from a reader who has been climbing for two seconds.
//
// Instrumented before the fix, with the same 30px steps and the same one
// message per step this test uses: the reader never got further than 46px from
// the tail in twelve seconds of continuous upward wheeling, 239 frames slipped
// backwards, and 99 of the settle pass's writes undid 24 626px of travel. After:
// 8 590px reached, no frame slipping back at all.
//
// Owns brackenisle@example.test (Bracken Isle), sedgewarbler@example.test
// (Sedge Warbler) and the Bracken Climb room: spec files run in parallel and a
// character holds one sim connection, so specs share neither (world.ts).

import { expect, test } from "./helpers.js";
import { climbTallHistory, TOLERANCE_PX } from "./history-climb.js";

const ROOM = "ADH-514historyclimb11aa22bb";
const ROOM_TITLE = "Bracken Climb";

/** How far the reader must get from the tail for the climb to have happened at
 * all. The wheel supplies 3 600px of travel; the defect capped it at 46. This
 * bound is far above the defect and far below the input, so it fails a log that
 * fights and passes one that merely loses a step to a slow runner. */
const MIN_CLIMB_PX = 1500;

test("a message arriving mid-climb never drags the reader back to the tail (#514)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const result = await climbTallHistory(page, {
    account: "brackenisle@example.test",
    character: "Bracken Isle",
    partnerAccount: "sedgewarbler@example.test",
    partner: "Sedge Warbler",
    room: ROOM,
    roomTitle: ROOM_TITLE,
    seedCount: 150,
    paragraphs: 2,
    wheelPx: 30,
    steps: 120,
    stepDelayMs: 100,
    liveEvery: 1,
  });

  expect(result.samples).toBeGreaterThan(100);
  expect(
    result.maxDistance,
    `the climb never got anywhere: ${JSON.stringify(result)}`,
  ).toBeGreaterThan(MIN_CLIMB_PX);
  expect(
    result.worstDrop,
    `the log pulled the reader ${String(result.worstDrop)}px back toward the tail ` +
      `(${String(result.worstAt.from)} → ${String(result.worstAt.to)} from the bottom), ` +
      `${String(result.fights)} frames of ${String(result.samples)}`,
  ).toBeLessThanOrEqual(TOLERANCE_PX);
});
