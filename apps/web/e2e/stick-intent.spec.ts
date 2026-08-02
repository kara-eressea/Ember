// The bottom-stick releases on USER INTENT, not on geometry.
//
// The log's "am I still glued to the newest messages?" intent used to be
// released by any scroll event that moved scrollTop up far enough
// (`movedUp && distanceFromBottom > STICK_RELEASE_PX`). That rule cannot tell
// a reader scrolling up from the browser moving the scroll under a parked log
// — and the second happens constantly: the virtualizer's own
// `applyScrollAdjustment` shifts scrollTop whenever a row re-measures, and a
// reflow (width change, font swap, a late image) does the same. Instrumented
// traces of a log sitting exactly at the bottom show both ingredients on their
// own — scroll events with scrollTop moving UP, and scroll events with
// distance-from-bottom in the thousands. Whenever they coincide the glue was
// dropped for good, and nothing on the mount/refocus path re-establishes it:
// the log stays parked at the old tail while messages pile up below it, which
// is the #411 report.
//
// These two tests are the mechanism, not a scenario: one drives the scroll
// with no user input at all (what the browser does), the other with a real
// wheel (what a reader does), and they must come out opposite.
//
// Owns tussock@example.test (Tussock Fen), haywick@example.test (Haywick Pell)
// and the Glasshouse room: specs never share an account, a character or a
// channel (world.ts).

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
/** Comfortably past STICK_RELEASE_PX (120) so the release rule's distance
 * condition is unambiguously met — the only variable under test is intent. */
const SHOVE_PX = 500;

const ROOM = "ADH-stickintent11aa22bb33";
const ROOM_TITLE = "Glasshouse";

function seedLine(n: number): string {
  const long =
    "This is a deliberately long line that wraps across several rows in the " +
    "log so the measured height is well above the virtualizer's flat estimate. ";
  const body = n % 3 === 0 ? long.repeat(3) : n % 2 === 0 ? long : "short";
  return `A#${String(n)} ${body}`;
}

function distanceFromBottom(page: Page) {
  return page
    .getByTestId("message-log")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Shove the scroll up the way the BROWSER does it: assign scrollTop with no
 * wheel, touch, key or pointer anywhere near it. This is precisely the shape
 * the virtualizer's re-measure adjustment produces — a scroll event whose
 * scrollTop moved up, with no user input behind it. */
function shoveScrollUpWithoutIntent(page: Page, px: number) {
  return page.getByTestId("message-log").evaluate((el, by) => {
    el.scrollTop -= by;
  }, px);
}

/** Seed a backlog tall enough that the log overflows several times over, and
 * settle at the tail. */
async function seedAndSettle(page: Page, partner: SimClient): Promise<void> {
  const log = page.getByTestId("message-log");
  for (let i = 1; i <= 30; i += 1) {
    partner.send("MSG", { channel: ROOM, message: `seed ${seedLine(i)}` });
    await delay(70);
  }
  await expect(log.getByText("seed A#30", { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => distanceFromBottom(page), { timeout: 10_000 })
    .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
  await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
}

test("a scroll the user did not make must not release the bottom-stick", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "tussock@example.test", "Tussock Fen");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const haywick = await SimClient.connect(
    "haywick@example.test",
    "hunter2",
    "Haywick Pell",
  );
  try {
    haywick.send("JCH", { channel: ROOM });
    await delay(500);
    const log = page.getByTestId("message-log");
    await seedAndSettle(page, haywick);

    // The browser moves the scroll under a parked log.
    await shoveScrollUpWithoutIntent(page, SHOVE_PX);
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 5_000 })
      .toBeGreaterThan(AT_BOTTOM_SLACK_PX);

    // The stick is not directly observable, so read it off the behaviour that
    // depends on it: the next arrival must pull the log back to the newest
    // message. With the glue dropped the log stays parked and the pill stays.
    haywick.send("MSG", { channel: ROOM, message: "after the shove" });
    await expect(log.getByText("after the shove", { exact: true })).toBeVisible(
      {
        timeout: 15_000,
      },
    );
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

    // It survives repetition — a re-measure storm is many such scrolls, not one.
    for (let i = 1; i <= 4; i += 1) {
      await shoveScrollUpWithoutIntent(page, SHOVE_PX);
      await delay(120);
    }
    haywick.send("MSG", { channel: ROOM, message: "after the storm" });
    await expect(log.getByText("after the storm", { exact: true })).toBeVisible(
      {
        timeout: 15_000,
      },
    );
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
  } finally {
    haywick.close();
  }
});

test("typing in the composer is not scroll intent", async ({ page }) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "tussock@example.test", "Tussock Fen");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const haywick = await SimClient.connect(
    "haywick@example.test",
    "hunter2",
    "Haywick Pell",
  );
  try {
    haywick.send("JCH", { channel: ROOM });
    await delay(500);
    const log = page.getByTestId("message-log");
    await seedAndSettle(page, haywick);

    // Space is a page-scroll key AND the commonest keystroke in a message;
    // ArrowUp scrolls a log but in the composer it recalls a pending send. If
    // either armed scroll intent, anyone mid-sentence would hold the release
    // window permanently open and the browser's own scrolls would strand the
    // log again — for exactly the people using the app hardest.
    const input = page.getByLabel("Message", { exact: true });
    await input.click();
    await input.pressSequentially("writing a reply here");
    await input.press("ArrowUp");

    // Straight into a browser-made scroll, well inside the intent window.
    await shoveScrollUpWithoutIntent(page, SHOVE_PX);
    haywick.send("MSG", { channel: ROOM, message: "landed mid-sentence" });
    await expect(
      log.getByText("landed mid-sentence", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

    // The draft is untouched by any of this.
    await expect(input).toHaveValue("writing a reply here");
  } finally {
    haywick.close();
  }
});

test("a scroll the user DID make still releases the bottom-stick (#415)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "tussock@example.test", "Tussock Fen");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const haywick = await SimClient.connect(
    "haywick@example.test",
    "hunter2",
    "Haywick Pell",
  );
  try {
    haywick.send("JCH", { channel: ROOM });
    await delay(500);
    const log = page.getByTestId("message-log");
    await seedAndSettle(page, haywick);

    // A real wheel, the way a reader leaves the tail.
    await log.hover();
    await page.mouse.wheel(0, -SHOVE_PX * 2);
    await expect(page.getByTestId("jump-to-recent")).toBeVisible();
    const parked = await distanceFromBottom(page);
    expect(parked).toBeGreaterThan(AT_BOTTOM_SLACK_PX);

    // The reader is reading: an arrival must NOT yank them back to the tail.
    haywick.send("MSG", { channel: ROOM, message: "arrived while reading" });
    await delay(1500);
    expect(await distanceFromBottom(page)).toBeGreaterThan(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).toBeVisible();

    // …and wheeling back down re-engages the glue, so the arrival after that
    // does follow again (#415: reaching the tail yourself is catching up).
    for (let i = 0; i < 14; i += 1) {
      if ((await distanceFromBottom(page)) <= AT_BOTTOM_SLACK_PX) {
        break;
      }
      await page.mouse.wheel(0, 600);
      await delay(150);
    }
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

    haywick.send("MSG", {
      channel: ROOM,
      message: "arrived after catching up",
    });
    await expect(
      log.getByText("arrived after catching up", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
  } finally {
    haywick.close();
  }
});
