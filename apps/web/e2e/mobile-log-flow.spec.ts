// The phone message flow and its pull-to-reveal gesture (#513), on both mobile
// projects — a Pixel-class Chromium context and an iPhone-class WebKit one.
//
// The bug this file guards is a geometry bug and can only be caught by
// measuring: with aligned columns on, a long roleplay post at 393px rendered
// as a one-word-wide ribbon beside a timestamp column and a 12em name column.
// So the assertions are boxes — how wide the body is, where the stamp is —
// rather than classes or attributes, which would have passed happily against
// the broken layout.
//
// **How the finger is driven.** Two transports behind one `Finger`, chosen by
// engine, because neither covers both:
//
//   - Chromium gets a REAL touch through CDP (`Input.dispatchTouchEvent`, the
//     primitive e2e/long-press.ts already uses), so the pull is exercised as
//     the engine's own pointer events under a live `touch-action`. Its other
//     half — that a vertical gesture still SCROLLS under that declaration —
//     needs `Input.synthesizeScrollGesture` instead, and is asserted as a
//     floor rather than a distance; `touchScrolledDistance` carries both
//     arguments and the numbers behind them.
//   - WebKit gets synthetic `PointerEvent`s dispatched at the element under
//     the point. `newCDPSession` throws on anything that is not Chromium and
//     Playwright's cross-engine touch API only taps, so this is the whole
//     menu. It exercises the recognizer, the CSS variable and the geometry on
//     the second engine, and is honest about not exercising `touch-action` —
//     which is asserted there as computed style instead.
//
// Owns ribbon@example.test (Ribbon Quaile), guttervane@example.test (Gutter
// Vane) and the Ribbon Room: spec files run in parallel and a character holds
// one sim connection, so specs share neither (world.ts).

import type { CDPSession, Locator, Page } from "@playwright/test";
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
/** Mirrors REVEAL_MAX_PX in pull-reveal.ts. */
const REVEAL_MAX_PX = 72;
/** "The log moved at all", for the one assertion about the compositor rather
 * than about our code — see `touchScrolledDistance` for why this is a floor and
 * not a distance. Deliberately well under the 60px at-bottom slack: it is not
 * asking the log to leave the tail, only to move. */
const SCROLLED_FLOOR_PX = 24;

const ROOM = "ADH-513phonelogflow55dd66ee";
const ROOM_TITLE = "Ribbon Room";
const PARTNER = "Gutter Vane";
const EICON = "tearsofjoy";

/** The report's shape of message: several sentences of roleplay that has to
 * wrap many times at 393px. Long names are the other half of the bug, so the
 * partner's is a two-word one and the room has nobody else in it. */
function roleplayLine(n: number): string {
  return (
    `Post ${String(n)}. She set the teacup down with the particular care of ` +
    "someone who has decided not to say the first thing that came to mind, " +
    "and looked at the window instead, where the rain had been going on for " +
    "long enough to stop being weather and start being furniture."
  );
}

function log(page: Page): Locator {
  return page.getByTestId("message-log");
}

/** The pull offset the log is currently publishing, in px. Unset reads 0 —
 * `var(--eb-log-reveal, 0px)` is the single definition of "not pulled". */
function revealPx(page: Page): Promise<number> {
  return log(page).evaluate((el) => {
    const raw = getComputedStyle(el).getPropertyValue("--eb-log-reveal");
    return Number.parseFloat(raw) || 0;
  });
}

function distanceFromBottom(page: Page): Promise<number> {
  return log(page).evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
  );
}

function scrollTop(page: Page): Promise<number> {
  return log(page).evaluate((el) => el.scrollTop);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) {
    throw new Error("element has no bounding box");
  }
  return found;
}

/** One finger, however this engine can produce one. */
interface Finger {
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  up(): Promise<void>;
}

const SYNTHETIC_POINTER_ID = 41;

function finger(page: Page, cdp: CDPSession | undefined): Finger {
  if (cdp !== undefined) {
    return {
      async down(x, y) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
      },
      async move(x, y) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y }],
        });
      },
      async up() {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      },
    };
  }
  // Dispatched at whatever is under the point, so the event walks the same
  // ancestor chain a real finger's would — which is what makes the long-press
  // interplay below a real test of both recognizers rather than of one.
  const dispatch = (type: string, x: number, y: number) =>
    page.evaluate(
      ({ type: kind, x: cx, y: cy, id }) => {
        const target = document.elementFromPoint(cx, cy) ?? document.body;
        target.dispatchEvent(
          new PointerEvent(kind, {
            bubbles: true,
            cancelable: true,
            pointerId: id,
            pointerType: "touch",
            isPrimary: true,
            clientX: cx,
            clientY: cy,
          }),
        );
      },
      { type, x, y, id: SYNTHETIC_POINTER_ID },
    );
  let last = { x: 0, y: 0 };
  return {
    async down(x, y) {
      last = { x, y };
      await dispatch("pointerdown", x, y);
    },
    async move(x, y) {
      last = { x, y };
      await dispatch("pointermove", x, y);
    },
    async up() {
      await dispatch("pointerup", last.x, last.y);
    },
  };
}

/** A drag in steps, so the axis lock sees movement rather than a teleport.
 * Leaves the finger DOWN at the end — the caller lifts it, because everything
 * interesting about this gesture is visible only while it is held. */
async function drag(
  hand: Finger,
  from: { x: number; y: number },
  delta: { dx: number; dy: number },
  steps = 6,
): Promise<void> {
  await hand.down(from.x, from.y);
  for (let step = 1; step <= steps; step += 1) {
    await hand.move(
      Math.round(from.x + (delta.dx * step) / steps),
      Math.round(from.y + (delta.dy * step) / steps),
    );
    await delay(16);
  }
}

/**
 * A momentum-free touch scroll up through the backlog, through the compositor.
 * `preventFling` keeps it deterministic: the view travels `distance` and stops
 * when the finger lifts, so what is asserted afterwards is a function of the
 * distance we chose rather than of the runner's load.
 *
 * On its OWN CDP session, deliberately: a session that has already dispatched
 * raw `Input.dispatchTouchEvent`s cannot synthesize a gesture afterwards.
 * Measured here — the identical call on the session the `Finger` above had used
 * moved the log 0px, and on a fresh session it moved 567px. Chromium keeps
 * touch-pointer state per session and the hand-rolled gesture leaves it
 * somewhere the synthesizer will not start from. (mobile-keyboard-scroll opens
 * a session per gesture as well, which is why it never met this.)
 */
async function scrollByTouch(page: Page, distance: number): Promise<void> {
  const target = await box(log(page));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.synthesizeScrollGesture", {
    x: Math.round(target.x + target.width / 2),
    y: Math.round(target.y + target.height / 2),
    yDistance: distance,
    gestureSourceType: "touch",
    speed: 6000,
    preventFling: true,
  });
  await cdp.detach();
}

/**
 * How far a real touch gesture actually moved the log — the furthest it got,
 * over a few attempts.
 *
 * A **floor**, never a distance, and the difference is the whole point of this
 * helper. The claim under test is binary: a `touch-action` that had taken the
 * vertical scroll away from the compositor would move the log zero pixels,
 * every time, on every machine. How far a *synthesized* gesture travels when it
 * does work is a property of the runner — the same call moved this log 567px on
 * a dev box, and this assertion, first written as "past the 120px stick
 * hysteresis", went red on CI twice while every local run passed. So the
 * threshold tests the product and the distance tested the hardware.
 *
 * Retried and polled for the same reason mobile-keyboard-scroll's `leaveTheTail`
 * is: a gesture that lands while the bottom-stick's multi-frame settle is still
 * writing scrollTop is fighting that loop rather than scrolling, and on a loaded
 * runner that has been measured to swallow most of a drag. The maximum across
 * the polls is what is reported, because a scroll short of the 120px hysteresis
 * never releases the stick — the log is entitled to slide back, and it still
 * moved.
 *
 * The distance-grade claims — a drag that leaves the tail for good, and a
 * fling's momentum tail after it — belong to mobile-keyboard-scroll, which owns
 * the escalation machinery for exactly this reason and runs against this same
 * `touch-action`.
 */
async function touchScrolledDistance(page: Page): Promise<number> {
  let furthest = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await scrollByTouch(page, 500);
    for (let poll = 0; poll < 20; poll += 1) {
      furthest = Math.max(furthest, await distanceFromBottom(page));
      if (furthest > SCROLLED_FLOOR_PX) {
        return furthest;
      }
      await delay(100);
    }
  }
  return furthest;
}

/** Seed the room and settle at the tail. */
async function seedAndSettle(page: Page, partner: SimClient): Promise<void> {
  for (let i = 1; i <= 14; i += 1) {
    partner.send("MSG", { channel: ROOM, message: roleplayLine(i) });
    await delay(70);
  }
  await expect(log(page).getByText("Post 14.", { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => distanceFromBottom(page), { timeout: 15_000 })
    .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
  // Quiescent: every arrival re-runs the bottom-stick's multi-frame settle,
  // and a gesture that starts inside one is fighting it (mobile-keyboard-
  // scroll's finding).
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 60 && stable < 4; i += 1) {
    const height = await log(page).evaluate((el) => el.scrollHeight);
    stable = height === previous ? stable + 1 : 0;
    previous = height;
    await delay(100);
  }
  expect(stable).toBeGreaterThanOrEqual(4);
}

/** Turn the reported pref on — idempotently, because preferences are stored
 * per app account and this spec's account outlives the browser context, so a
 * CI retry would otherwise toggle it back off. */
async function alignColumnsOn(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Preferences" }).click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await prefs.getByRole("button", { name: "Appearance" }).click();
  const toggle = prefs.getByRole("switch", { name: "Aligned columns" });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await prefs.getByRole("button", { name: "Close preferences" }).click();
  await expect(prefs).toHaveCount(0);
}

test("phone: the log is full width with aligned columns on, and the pull brings the stamps in (#513)", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "ribbon@example.test", "Ribbon Quaile");
  // The reported configuration — turned on BEFORE the room opens, so nothing
  // below is measuring a log mid-reflow.
  await alignColumnsOn(page);
  await joinChannel(page, ROOM, ROOM_TITLE);

  const partner = await SimClient.connect(
    "guttervane@example.test",
    "hunter2",
    PARTNER,
  );
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  try {
    partner.send("JCH", { channel: ROOM });
    await delay(500);
    await seedAndSettle(page, partner);

    // ── The pref is still on, and the log still overrides it ─────────────
    await expect(log(page)).toHaveAttribute("data-log-flow", "inline");

    // ── The body is the width of the screen, not of a leftover column ────
    // This is the assertion the bug would have failed: aligned columns cost a
    // timestamp plus 12em of name, which at 393px left the body under half the
    // log. `boundingBox()` of an inline element is the union of its line
    // boxes, so for wrapped prose it IS the usable text width.
    const logBox = await box(log(page));
    const body = log(page).getByText("she set the teacup down", {
      exact: false,
    });
    await expect(body.first()).toBeVisible();
    const bodyBox = await box(body.first());
    expect(bodyBox.width).toBeGreaterThan(logBox.width * 0.85);

    // ── …and the timestamp is not on the line at all ─────────────────────
    // It still exists — it is the thing the pull uncovers — but it has left
    // the flow and sits outside the log's leading edge.
    const stamp = log(page).getByTestId("message-time").first();
    expect(await stamp.evaluate((el) => getComputedStyle(el).position)).toBe(
      "absolute",
    );
    const parked = await box(stamp);
    expect(parked.x + parked.width).toBeLessThanOrEqual(logBox.x);

    // ── The gesture contract the compositor reads ────────────────────────
    // `pan-y` first, so a horizontal drag reaches JS and a vertical one is
    // still scrolled by the compositor. Asserted as a prefix: the pinch-zoom
    // half is a progressive enhancement over a `pan-y` fallback.
    expect(
      await log(page).evaluate((el) => getComputedStyle(el).touchAction),
    ).toMatch(/^pan-y/);

    // ── The pull ─────────────────────────────────────────────────────────
    const restingTop = await scrollTop(page);
    const restingHeight = await log(page).evaluate((el) => el.scrollHeight);
    const hand = finger(page, cdp);
    const from = {
      x: Math.round(logBox.x + logBox.width / 2),
      y: Math.round(logBox.y + logBox.height / 2),
    };
    await drag(hand, from, { dx: 120, dy: 0 });

    // Held: the rows have travelled, capped, and the stamp is in the gutter
    // the shift opened — on screen, and left of where the prose starts.
    const held = await revealPx(page);
    expect(held).toBeGreaterThan(REVEAL_MAX_PX / 2);
    expect(held).toBeLessThanOrEqual(REVEAL_MAX_PX + 24);
    const revealed = await box(stamp);
    expect(revealed.x).toBeGreaterThanOrEqual(logBox.x);
    // …in the gutter, i.e. still well left of where the prose starts.
    expect(revealed.x + revealed.width).toBeLessThan(logBox.x + held + 1);

    // ── The #454 gate is untouched by a claimed horizontal pan ───────────
    // A pull fires no scroll event at all — there is nothing for the stick
    // release to read — so the log has not moved and the jump pill has not
    // armed. Measured while the finger is still down, which is when the
    // pointer-held half of `userDrivingScroll` is true.
    expect(await scrollTop(page)).toBeCloseTo(restingTop, 0);
    expect(await log(page).evaluate((el) => el.scrollHeight)).toBe(
      restingHeight,
    );
    await expect(page.getByTestId("jump-to-recent")).toHaveCount(0);

    // ── Release snaps back ───────────────────────────────────────────────
    await hand.up();
    await expect.poll(() => revealPx(page), { timeout: 5_000 }).toBe(0);
    const settled = await box(stamp);
    expect(settled.x + settled.width).toBeLessThanOrEqual(logBox.x);
    expect(await scrollTop(page)).toBeCloseTo(restingTop, 0);
    await expect(page.getByTestId("jump-to-recent")).toHaveCount(0);

    // ── The log is still live at the tail afterwards ─────────────────────
    partner.send("MSG", { channel: ROOM, message: "Post 15. And after." });
    await expect(log(page).getByText("Post 15.", { exact: false })).toBeVisible(
      { timeout: 15_000 },
    );
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 15_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
  } finally {
    await cdp?.detach();
    partner.close();
  }
});

test("phone: a pull over a claimed element opens no sheet, and a vertical gesture reveals nothing (#513)", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "ribbon@example.test", "Ribbon Quaile");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const partner = await SimClient.connect(
    "guttervane@example.test",
    "hunter2",
    PARTNER,
  );
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  try {
    partner.send("JCH", { channel: ROOM });
    await delay(500);
    await seedAndSettle(page, partner);

    const logBox = await box(log(page));
    const hand = finger(page, cdp);
    const centre = {
      x: Math.round(logBox.x + logBox.width / 2),
      y: Math.round(logBox.y + logBox.height * 0.7),
    };

    // ── A pull that starts on a long-press target opens nothing ──────────
    // First, while the log is settled at the tail: this half needs the eicon
    // rendered, and the log is virtualized, so it has to run before anything
    // scrolls away from the newest messages.
    //
    // The two recognizers nest by threshold rather than by arbitration: the
    // axis lock claims at 8px and `useLongPress` cancels at 10px of slop, so
    // any pull that is doing anything visible has already disarmed the press
    // it started. Verified against the real machinery — the eicon here is the
    // element the action sheet actually hangs off (RichText's `useEiconPress`).
    partner.send("MSG", {
      channel: ROOM,
      message: `Post 16. Found you [eicon]${EICON}[/eicon]`,
    });
    const eicon = log(page).getByRole("img", { name: EICON });
    await expect(eicon).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 15_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);

    const target = await box(eicon);
    await drag(
      hand,
      {
        x: Math.round(target.x + target.width / 2),
        y: Math.round(target.y + target.height / 2),
      },
      { dx: 110, dy: 0 },
      8,
    );
    expect(await revealPx(page)).toBeGreaterThan(REVEAL_MAX_PX / 2);
    // Held well past the 450ms hold threshold, so a recognizer that ignored
    // the movement would have fired twice over by now.
    await delay(900);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await hand.up();
    await expect.poll(() => revealPx(page), { timeout: 5_000 }).toBe(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ── The axis lock releases a vertical gesture entirely ───────────────
    // Including one that turns sideways halfway through: the decision is made
    // once, on the first movement past the threshold, and a scroll already
    // handed to the compositor is never taken back.
    await drag(hand, centre, { dx: 0, dy: -160 });
    expect(await revealPx(page)).toBe(0);
    await hand.move(centre.x + 140, centre.y - 160);
    expect(await revealPx(page)).toBe(0);
    await hand.up();
    expect(await revealPx(page)).toBe(0);

    // ── …and the compositor still owns the vertical scroll ───────────────
    // The other half of `touch-action: pan-y`, and the half no synthetic event
    // can speak to: the declaration is read by the compositor, so only a real
    // finger says whether the log still scrolls under one. Last in the test,
    // because it is the one step that deliberately leaves the tail.
    //
    // Chromium-only: `Input.synthesizeScrollGesture` is the only API anywhere
    // that hands a compositor a gesture, and `newCDPSession` throws on
    // anything else — the same scope-out mobile-keyboard-scroll's fling
    // carries. The hand-rolled `Finger` above will not do instead: the same
    // 160px of dispatched touchmoves moved this log 11px, because raw
    // `Input.dispatchTouchEvent` is a faithful way to deliver *events* (all
    // long-press.ts asks of it) and a poor way to drive a *scroll*.
    if (cdp !== undefined) {
      expect(await touchScrolledDistance(page)).toBeGreaterThan(
        SCROLLED_FLOOR_PX,
      );
      expect(await revealPx(page)).toBe(0);
    }
  } finally {
    await cdp?.detach();
    partner.close();
  }
});
