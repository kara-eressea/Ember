// Climbing history must never be fought back toward the tail (#514), on a
// phone.
//
// This is where the report came from and where the defect was pathological. At
// 393px a roleplay post measures ~500px, so the 120px the bottom-stick needs
// before it lets go is a quarter of one message — and the reader could not
// supply it, because the log kept resetting their progress. The engine was a
// loop the phone tier built by itself: `position: relative` on the "Jump to
// newest" pill (from the 44px touch-target round) put it back into the log's
// flex column, so the pill's own appearance shortened the log by its own
// height, the #284 re-stick observer read the shrink and glued to the tail, the
// tail hid the pill, the log grew back, and the whole thing armed again.
//
// Instrumented before the fix, with the same steps this test uses: 160 yanks in
// twelve seconds, every one of them dropping the reader from 150px off the tail
// to exactly 0, 24 000px of travel undone, the reading position never leaving
// the newest post. After: 19 200px reached — every pixel of wheel the test
// supplied — and no frame slipping back at all.
//
// The wheel drives it rather than a finger, for the reason mobile-log-flow's
// header records: a synthesized touch scroll moves this log exactly 0px on CI.
// The wheel reproduces the defect regardless, because the mechanism is about
// the size of each increment against the release hysteresis and not about which
// device produced it. The touch-direction half of the fix has unit coverage
// instead (MessageLog.climb.test.tsx).
//
// Owns marram@example.test (Marram Dune), shingleharrow@example.test (Shingle
// Harrow) and the Marram Climb room: spec files run in parallel and a character
// holds one sim connection, so specs share neither (world.ts).

import { expect, test } from "./helpers.js";
import { climbTallHistory, TOLERANCE_PX } from "./history-climb.js";

const ROOM = "ADH-514phoneclimb33cc44dd";
const ROOM_TITLE = "Marram Climb";

/** The wheel supplies 12 000px of travel; the defect capped it at 150. */
const MIN_CLIMB_PX = 4000;

test("climbing tall history on a phone is never pulled back to the tail (#514)", async ({
  page,
  browserName,
}) => {
  // Playwright throws "Mouse wheel is not supported in mobile WebKit" outright
  // here, and the finger that would replace it does not scroll on CI
  // (mobile-log-flow's header) — so there is no input on this engine that moves
  // this log. The half of the fix that IS engine-specific is the CSS one, and
  // mobile-targets measures the pill's touch target on both engines already.
  test.skip(
    browserName === "webkit",
    "Mouse wheel is not supported in mobile WebKit",
  );
  test.setTimeout(180_000);
  const result = await climbTallHistory(page, {
    account: "marram@example.test",
    character: "Marram Dune",
    partnerAccount: "shingleharrow@example.test",
    partner: "Shingle Harrow",
    room: ROOM,
    roomTitle: ROOM_TITLE,
    seedCount: 120,
    paragraphs: 3,
    wheelPx: 60,
    steps: 200,
    stepDelayMs: 50,
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
