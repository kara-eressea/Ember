// The two touch input modes MP2 package B adds to the log (#376), on the
// `mobile-chromium` project — a Pixel 5 context with `hasTouch`, which is what
// makes a synthesized touch fling produce real momentum instead of a discrete
// jump.
//
// 1. A FLING. Every scroll invariant in MessageLog was built against wheel and
//    keyboard input, where an input event accompanies every scroll event. Touch
//    breaks that: the flick hands the scroll to the compositor and the browser
//    keeps moving it for up to ~1s after the finger is gone, with no input
//    event of any kind — so the #454 intent window, which is anchored to the
//    last `touchmove`, expires while the gesture is visibly still running. The
//    question is whether those late, un-attributed scroll events can be read as
//    "the log reached the bottom on its own" and re-engage the glue under a
//    reader who is still moving.
//
//    They cannot, on this engine, and the numbers are worth recording because
//    the obvious reading of the code says otherwise. Instrumenting three
//    synthesized flings (80px@6000, 80px@1500, 40px@800) shows Chromium's
//    deceleration is heavily front-loaded — every gesture that crosses the
//    120px hysteresis at all crosses it 21ms, 35ms and 145ms after `touchend`
//    respectively, all far inside the 500ms window, with the long tail beyond
//    500ms only ever adding distance the stick has already been released over.
//    In the other direction the ungated re-stick is unreachable mid-fling: an
//    upward fling only ever grows the distance from the bottom, so `bottom`
//    never becomes true. The gate needed no change; this test is the guard that
//    says so, and the thing that will notice if a future engine's fling curve
//    (or a change to the window) breaks the assumption.
//
//    Structured in two gestures on purpose: a momentum-free DRAG leaves the
//    tail (deterministic — it depends on distance, which we choose), and only
//    then a FLING supplies the momentum tail under test. How far a fling
//    actually travels depends on how much velocity the machine synthesizes, so
//    it is never asserted on; the assertions are about where the log is NOT.
//
// 2. THE SOFT KEYBOARD. There is no way to raise a real one under automation,
//    and the CDP surfaces that look like they should help do not: measured
//    here, `Emulation.setVisibleSize` is a no-op in current Chromium, and
//    `Emulation.setDeviceMetricsOverride` with a shorter height shrinks the
//    LAYOUT viewport too — which is `interactive-widget=resizes-content`
//    behaviour, i.e. the one case where our module is meant to do nothing. So
//    the keyboard is driven by shimming `window.visualViewport` itself, which
//    reproduces the exact signal the engine emits on the default
//    (`resizes-visual`) path: visual height shrinks, `documentElement
//    .clientHeight` does not, `resize` fires. Everything downstream of that
//    signal — the inset arithmetic, the CSS property, the shell's height, the
//    composer's position, the log's tail — is the real code under test. What it
//    cannot cover is the engine's own focus auto-scroll, so the last test does
//    that half for real, with a real tap and a real caret.
//
// The two halves split across the engines (MP4, #378). The FLING is Chromium's
// alone — `Input.synthesizeScrollGesture` is the only API anywhere that hands a
// compositor a velocity, and a hand-rolled touchmove sequence would carry this
// file's momentum rather than the engine's. THE KEYBOARD runs on both, and is
// the more valuable of the two to have there: the shim is `addInitScript`, not
// CDP, so it reproduces the same signal on WebKit — and WebKit is the engine
// `visual-viewport.ts` was written for. The inset arithmetic, the shell shrink
// and the log's tail are now measured on it.
//
// Owns mitten@example.test (Mitten Vale), driftwood@example.test (Driftwood
// Ash) and the Lantern Room: spec files run in parallel and a character holds
// one sim connection, so specs share neither (world.ts).

import type { Page } from "@playwright/test";
import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

/** Mirrors AT_BOTTOM_SLACK_PX in MessageLog — within this counts as bottom. */
const AT_BOTTOM_SLACK_PX = 60;
/** Mirrors STICK_RELEASE_PX in MessageLog — the hysteresis a scroll has to
 * cross before the glue is released. */
const STICK_RELEASE_PX = 120;
/** Finger travel of the opening DRAG — comfortably past the hysteresis, and
 * with no momentum, so the release is a function of distance alone and not of
 * how much velocity the runner managed to synthesize. */
const DRAG_PX = 500;
/** Finger travel of the flick that follows. Deliberately short: its job is to
 * produce a momentum tail, not to move the log anywhere in particular. */
const FLICK_PX = 120;
/** A soft keyboard's worth of visual viewport, roughly Android's. */
const KEYBOARD_PX = 300;

const ROOM = "ADH-376keyboardfling88cc99dd";
const ROOM_TITLE = "Lantern Room";

function seedLine(n: number): string {
  const long =
    "A line long enough to wrap several times at 393px, so the log overflows " +
    "its viewport many times over and a fling has somewhere to travel. ";
  return `Line ${String(n)} ${n % 3 === 0 ? long.repeat(2) : long}`;
}

function distanceFromBottom(page: Page) {
  return page
    .getByTestId("message-log")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** The log's total content height. This is how an arrival is detected while the
 * reader is parked up in the backlog: the log is VIRTUALIZED, so a message that
 * lands at the tail while we are 500px above it is never rendered and never
 * becomes attached — but it does make the content taller. */
function scrollHeight(page: Page) {
  return page.getByTestId("message-log").evaluate((el) => el.scrollHeight);
}

/** How far the log COULD be scrolled — the range a drag has to work with. */
function scrollableRange(page: Page) {
  return page
    .getByTestId("message-log")
    .evaluate((el) => el.scrollHeight - el.clientHeight);
}

/** The scrollable range every gesture below needs to exist before it fires:
 * the drag's travel, plus the hysteresis it has to end up beyond, plus room for
 * the fling that follows. */
const REQUIRED_RANGE_PX = DRAG_PX + STICK_RELEASE_PX + 200;

/** Seed a backlog tall enough to fling through, and settle at the tail. */
async function seedAndSettle(page: Page, partner: SimClient): Promise<void> {
  const log = page.getByTestId("message-log");
  for (let i = 1; i <= 30; i += 1) {
    partner.send("MSG", { channel: ROOM, message: `seed ${seedLine(i)}` });
    await delay(70);
  }
  await expect(log.getByText("Line 30", { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => distanceFromBottom(page), { timeout: 10_000 })
    .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
  await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

  // Two preconditions the old version was missing, both of which show up only
  // as "the drag did nothing" (distance stays exactly 0) on a slow runner.
  //
  // 1. There is something to scroll. "Distance from the bottom is 0" is
  //    satisfied just as well by a log with NOTHING TO SCROLL as by one parked
  //    at the tail of a deep backlog, and so is "the last line is visible" —
  //    the tail renders first.
  await expect
    .poll(() => scrollableRange(page), { timeout: 30_000 })
    .toBeGreaterThan(REQUIRED_RANGE_PX);

  // 2. The log is QUIESCENT. Every arrival re-runs the bottom-stick's
  //    multi-frame settle, which writes scrollTop to the bottom for several
  //    frames after the message lands, so a gesture that starts while messages
  //    are still arriving is fighting that loop rather than scrolling. Measured
  //    under a 6x CPU throttle: one message landing mid-drag cut the drag's
  //    travel from 466px to 197px. That is a real effect and this waits it out —
  //    though note it was never driven all the way to zero locally, so it is a
  //    contributing hazard rather than a proven account of the CI failure. See
  //    leaveTheTail for what actually makes the precondition safe.
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 100 && stable < 5; i += 1) {
    const height = await scrollHeight(page);
    stable = height === previous ? stable + 1 : 0;
    previous = height;
    await delay(100);
  }
  expect(stable).toBeGreaterThanOrEqual(5);
}

/**
 * A touch gesture up through the backlog, through the compositor.
 *
 * `fling` is the whole distinction. With `preventFling: true` this is a plain
 * drag: the view travels `distance` and stops dead when the finger lifts, which
 * makes it a deterministic way to put the log at a known offset. With
 * `preventFling: false` the compositor keeps moving the scroll after liftoff,
 * which is the momentum tail the second half of the test is about — and how far
 * that tail travels is a function of the synthesized velocity, i.e. of how busy
 * the machine is. Nothing may assert on the distance a fling covers.
 *
 * Positive yDistance scrolls the CONTENT down, i.e. moves the view UP toward
 * older messages — the "let me re-read that" gesture. Returns as soon as the
 * gesture is dispatched, while any momentum is still running.
 */
async function scrollUpByTouch(
  page: Page,
  distance: number,
  { fling }: { fling: boolean },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  // Read off the LIVE rect every time rather than a remembered one: the phone
  // shell reflows (the toolbar collapsing, the keyboard inset) and the centre of
  // the log is only knowable after layout has settled. The centre is also what
  // keeps the gesture clear of the two things overlapping this element's edges —
  // the "jump to recent" pill at the bottom and the composer below it.
  const box = await page.getByTestId("message-log").boundingBox();
  if (box === null) {
    throw new Error("no message log to scroll");
  }
  if (box.height < 200) {
    throw new Error(
      `message log is only ${String(Math.round(box.height))}px tall — the shell has not laid out`,
    );
  }
  await cdp.send("Input.synthesizeScrollGesture", {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
    yDistance: distance,
    gestureSourceType: "touch",
    speed: 6000,
    preventFling: !fling,
  });
  await cdp.detach();
}

/** Poll briefly for the log to be off the tail. Returns whether it got there. */
async function offTailWithin(page: Page, samples: number): Promise<boolean> {
  for (let poll = 0; poll < samples; poll += 1) {
    if ((await distanceFromBottom(page)) > STICK_RELEASE_PX) {
      return true;
    }
    await delay(100);
  }
  return false;
}

/**
 * Get the log off the tail — the PRECONDITION for the momentum test, not the
 * thing being tested.
 *
 * Worth being explicit about why this is defensive out of proportion to its
 * apparent difficulty. This spec went red on CI twice, the second time with the
 * drag below doing nothing at all: distance from the bottom sat at exactly 0
 * for the full 15s the assertion polled. That symptom was never reproduced
 * locally — not at 6x CPU throttle, not with a message landing mid-gesture
 * (which was measured to cut a drag's travel from 466px to 197px but never to
 * zero), so the root cause on that runner is not established, and a fix aimed
 * at a cause I cannot demonstrate is a guess.
 *
 * So this is built around the SYMPTOM instead, in two escalating steps:
 *
 *   1. A momentum-free touch drag, retried a bounded number of times. This is
 *      the realistic gesture and the one worth exercising on the mobile tier.
 *   2. If the log is still glued, a plain wheel scroll. Not a hack: how the
 *      reader left the tail is incidental to this test, whose subject is what
 *      happens to the scroll AFTER a fling's finger lifts. The wheel is the
 *      primitive stick-intent.spec.ts has used to leave the tail since #415 and
 *      it is proven on this CI; falling back to it means the precondition
 *      cannot be what fails, while the fling that follows is still a real touch
 *      gesture making the real claim.
 *
 * Silent when it succeeds by either route; the caller's assertion reports the
 * failure if neither works, so a genuinely stuck log is still a red test.
 */
async function leaveTheTail(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await scrollUpByTouch(page, DRAG_PX, { fling: false });
    if (await offTailWithin(page, 20)) {
      return;
    }
  }
  // Fallback: the wheel this suite already trusts on CI.
  const log = page.getByTestId("message-log");
  await log.hover();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.mouse.wheel(0, -DRAG_PX);
    if (await offTailWithin(page, 5)) {
      return;
    }
  }
}

/**
 * Poll until the log's scroll position stops moving, and report the CLOSEST it
 * ever came to the bottom on the way. Momentum is asynchronous and its duration
 * is machine-dependent, so this is how the test waits for a fling to finish
 * without a sleep — and the minimum is what turns "it ended up off-tail" into
 * the stronger claim the spec actually makes: it was never dragged back to the
 * tail at any point during the tail, either.
 */
async function settleAndTrackClosestApproach(page: Page): Promise<number> {
  let previous = Number.NaN;
  let stableSamples = 0;
  let closest = Number.POSITIVE_INFINITY;
  // ~6s of headroom: several times the ~1s momentum measured on a dev machine,
  // so a slow runner has room, while a log that never settles still fails.
  for (let i = 0; i < 60 && stableSamples < 4; i += 1) {
    const distance = await distanceFromBottom(page);
    closest = Math.min(closest, distance);
    stableSamples = distance === previous ? stableSamples + 1 : 0;
    previous = distance;
    await delay(100);
  }
  return closest;
}

test("a short touch flick releases the bottom-stick and the momentum tail never re-sticks it (#376)", async ({
  page,
  browserName,
}) => {
  // Chromium only, and the reason is the subject rather than the tooling
  // (MP4, #378). A fling is a *velocity* handed to the compositor, and
  // `Input.synthesizeScrollGesture` is the only API on any engine that
  // produces one; WebKit exposes no equivalent, and a hand-rolled sequence of
  // touchmoves would carry whatever momentum this file synthesized, not
  // whatever WebKit's compositor decides — i.e. it would test the test.
  // Which is exactly the gap mp2-touch.md §6 already records as real-device
  // work: the deceleration table in §5-B is Blink's, and whether WebKit's tail
  // crosses the 120px hysteresis later than the 500ms intent window is a
  // question only an iPhone can answer.
  test.skip(
    browserName === "webkit",
    "Input.synthesizeScrollGesture is Chromium-only; a fling's momentum cannot be synthesized cross-engine (mp2-touch.md §6)",
  );
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "mitten@example.test", "Mitten Vale");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const driftwood = await SimClient.connect(
    "driftwood@example.test",
    "hunter2",
    "Driftwood Ash",
  );
  try {
    driftwood.send("JCH", { channel: ROOM });
    await delay(500);
    const log = page.getByTestId("message-log");
    await seedAndSettle(page, driftwood);

    // ── 1. Leave the tail deterministically ──────────────────────────────
    // A momentum-free drag, well past the hysteresis. The release is then a
    // function of distance alone. (The first cut of this test used the fling
    // below for both jobs, asserting it travelled past STICK_RELEASE_PX — which
    // held on a dev machine and failed on CI, where the synthesized gesture
    // carries less velocity. How far a fling travels is a property of the
    // runner, not of the log, so nothing here may depend on it.)
    await leaveTheTail(page);
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 15_000 })
      .toBeGreaterThan(STICK_RELEASE_PX);
    await expect(page.getByTestId("jump-to-recent")).toBeVisible();
    const parked = await distanceFromBottom(page);

    // ── 2. …then fling, and let the momentum tail run out ────────────────
    // This is the claim: the scroll events that keep arriving after the finger
    // is gone must not be read as "the log arrived at the bottom by itself" and
    // re-engage the glue. The distance the fling covers is not asserted — only
    // that the log never approaches the tail while it is running.
    await scrollUpByTouch(page, FLICK_PX, { fling: true });
    const closest = await settleAndTrackClosestApproach(page);
    expect(closest).toBeGreaterThan(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).toBeVisible();
    // A fling up cannot end nearer the bottom than where it started.
    expect(await distanceFromBottom(page)).toBeGreaterThanOrEqual(parked);

    // ── 3. An arrival must not yank the reader back ──────────────────────
    // What fails if the momentum tail is ever misread as a non-user scroll and
    // the glue is therefore never released.
    const settled = await distanceFromBottom(page);
    const heightBefore = await scrollHeight(page);
    driftwood.send("MSG", { channel: ROOM, message: "arrived while reading" });
    // Waiting on the content growing, not on the row appearing: parked this far
    // up, the virtualizer never renders a row at the tail.
    await expect
      .poll(() => scrollHeight(page), { timeout: 15_000 })
      .toBeGreaterThan(heightBefore);
    const closestAfterArrival = await settleAndTrackClosestApproach(page);
    expect(closestAfterArrival).toBeGreaterThan(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).toBeVisible();
    // Stronger than "not at the bottom": the reader did not drift toward it at
    // all. A message appends content BELOW the viewport, so the distance from
    // the bottom can only grow while the view stays put — the small slack is
    // for the row re-measuring as it settles, not for movement.
    expect(await distanceFromBottom(page)).toBeGreaterThanOrEqual(settled - 20);

    // Returning is still one tap, and the glue re-engages for good.
    await page.getByTestId("jump-to-recent").click();
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

    driftwood.send("MSG", {
      channel: ROOM,
      message: "arrived after returning",
    });
    await expect(
      log.getByText("arrived after returning", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
  } finally {
    driftwood.close();
  }
});

test("the composer rides above the soft keyboard and the log keeps its tail (#376)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // Installed before any page script, so lib/visual-viewport.ts subscribes to
  // the shim rather than the real object. The shim only ever *shrinks* the
  // reported visual height — the layout viewport is untouched, which is the
  // whole distinction the module exists to measure.
  await page.addInitScript(() => {
    const real = window.visualViewport;
    const handlers = new Map<string, Set<() => void>>();
    let inset = 0;
    const shim = {
      get height() {
        return (real?.height ?? window.innerHeight) - inset;
      },
      get width() {
        return real?.width ?? window.innerWidth;
      },
      get offsetTop() {
        return 0;
      },
      get offsetLeft() {
        return 0;
      },
      get pageTop() {
        return 0;
      },
      get pageLeft() {
        return 0;
      },
      get scale() {
        return 1;
      },
      addEventListener(type: string, fn: () => void) {
        const set = handlers.get(type) ?? new Set<() => void>();
        set.add(fn);
        handlers.set(type, set);
      },
      removeEventListener(type: string, fn: () => void) {
        handlers.get(type)?.delete(fn);
      },
    };
    Object.defineProperty(window, "visualViewport", {
      get: () => shim,
      configurable: true,
    });
    Object.defineProperty(window, "__setKeyboard", {
      value: (px: number) => {
        inset = px;
        for (const fn of handlers.get("resize") ?? []) {
          fn();
        }
      },
      configurable: true,
    });
  });

  await provisionAndConnect(page, "mitten@example.test", "Mitten Vale");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const driftwood = await SimClient.connect(
    "driftwood@example.test",
    "hunter2",
    "Driftwood Ash",
  );
  try {
    driftwood.send("JCH", { channel: ROOM });
    await delay(500);
    await seedAndSettle(page, driftwood);

    const composer = page.getByLabel("Message", { exact: true });
    const viewportHeight = page.viewportSize()?.height ?? 0;

    // Baseline: no keyboard, no property, and the shell fills the window.
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--eb-keyboard-inset"),
      ),
    ).toBe("");

    // A real tap on the composer first: on a device context this is what a user
    // does, and it is the moment the engine would auto-scroll the focused field
    // into view. Doing it before the shim fires means any such scroll has to
    // survive the resize that follows.
    await composer.click();
    await expect(composer).toBeFocused();

    // Up it comes.
    await page.evaluate((px) => {
      (
        window as unknown as { __setKeyboard: (n: number) => void }
      ).__setKeyboard(px);
    }, KEYBOARD_PX);
    await delay(400); // the tracker coalesces into a frame; let it settle

    // The module measured it and published it in the root's own pixels.
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--eb-keyboard-inset"),
      ),
    ).toBe(`${String(KEYBOARD_PX)}px`);
    expect(await page.getAttribute("html", "data-keyboard")).toBe("open");

    // The thing a user cares about: the composer is above the keyboard line,
    // not behind it. The visual viewport now ends KEYBOARD_PX short of the
    // window, and the composer's bottom edge has to be inside that.
    const keyboardLine = viewportHeight - KEYBOARD_PX;
    const box = await composer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(keyboardLine);
    // …and still on screen rather than squeezed away to nothing.
    expect(box!.height).toBeGreaterThan(10);
    expect(box!.y).toBeGreaterThan(0);

    // The #372 invariant under its new trigger: the log was at the tail when
    // the keyboard opened, so it is at the tail after the resize settles. The
    // log's viewport just lost 300px, which is a container resize like any
    // other — the point is that the #284 ResizeObserver re-sticks it.
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

    // Messages arriving while the keyboard is up still land in view.
    driftwood.send("MSG", { channel: ROOM, message: "typed at you" });
    await expect(
      page
        .getByTestId("message-log")
        .getByText("typed at you", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);

    // Down it goes: every trace removed, and the tail still held.
    await page.evaluate(() => {
      (
        window as unknown as { __setKeyboard: (n: number) => void }
      ).__setKeyboard(0);
    });
    await delay(400);
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--eb-keyboard-inset"),
      ),
    ).toBe("");
    expect(await page.getAttribute("html", "data-keyboard")).toBeNull();
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
  } finally {
    driftwood.close();
  }
});
