// #411: coming BACK to a conversation that took a few unread messages while
// you were elsewhere must land on those messages — at the live tail, with the
// "new since you left" divider on screen and no "Jump to newest" pill.
//
// These are GUARDS, not a reproduction. The v0.19.0 re-report of #411 did not
// reproduce on any engine available here (see the PR/issue thread): both paths
// below were measured green across Chromium (dev bundle and the `vite preview`
// production bundle, 1x-20x CPU throttling), WebKit, warm and cold buffers,
// tall and short viewports, and ~60 switch-back trials. Firefox — the
// reporter's engine, per #419/#432 — cannot launch in this environment. The
// earlier fixes in this family covered the two paths that DID have a proven
// mechanism (a stale search-jump view, #423; reaching the tail by scrolling,
// #422); these two tests lock in the plain paths so a future refactor cannot
// break them silently while the real variant is still being hunted.
//
// Two readings of "tab back to a channel", both exercised:
//   (a) sidebar click back to the conversation (the log remounts), and
//   (b) the window regaining focus with the conversation already open (the log
//       never unmounts — the #440 focus seam).
//
// (b) uses the blur/focus events the app's own tracker listens to
// (lib/window-focus.ts), which is exactly the state a window is in when the
// user alt-tabs to another application: still VISIBLE (rAF and ResizeObserver
// keep running), just unfocused. A genuinely hidden tab cannot be emulated
// from Playwright — `bringToFront()` leaves the other page's
// `visibilityState` at "visible" and its rAF running (measured), and the CDP
// lifecycle overrides are either rejected or undone by the next evaluate.
//
// Owns seedwright@example.test (Seedwright Vale), almond@example.test (Almond
// Fitch) and the Potting Bench / Cold Frame rooms: specs never share an
// account, a character or a channel (world.ts).

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

const ROOM = "ADH-411pottingbench66aa77bb";
const ROOM_TITLE = "Potting Bench";
const ASIDE = "ADH-411coldframe88cc99dd";
const ASIDE_TITLE = "Cold Frame";

/** A spread of lengths so rows measure well above the virtualizer's flat 26px
 * estimate — the condition every landed-short defect in this family needed. */
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

/** How far the "new since you left" divider sits below the log's bottom edge,
 * in px (negative = on screen). Landing at the tail is not enough on its own:
 * the unread messages have to be readable without scrolling, and the divider
 * is the top of them. */
async function dividerBelowFold(page: Page): Promise<number> {
  const log = await page.getByTestId("message-log").boundingBox();
  const divider = await page.getByTestId("new-divider").boundingBox();
  if (log === null || divider === null) {
    return Number.POSITIVE_INFINITY;
  }
  return divider.y - (log.y + log.height);
}

function setWindowFocus(page: Page, focused: boolean): Promise<void> {
  return page.evaluate((on) => {
    window.dispatchEvent(new Event(on ? "focus" : "blur"));
  }, focused);
}

/** Seed a tall, fully-read backlog in ROOM so the log genuinely overflows and
 * the tail is somewhere you have to be put, not somewhere you fall. */
async function seedReadBacklog(page: Page, partner: SimClient): Promise<void> {
  const log = page.getByTestId("message-log");
  for (let i = 1; i <= 30; i += 1) {
    partner.send("MSG", { channel: ROOM, message: `seed ${seedLine(i)}` });
    await delay(70);
  }
  await expect(log.getByText("seed A#30", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(() => distanceFromBottom(page), { timeout: 10_000 })
    .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
}

test("clicking back into a channel that took a few unreads lands at the tail (#411)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "seedwright@example.test", "Seedwright Vale");
  await joinChannel(page, ASIDE, ASIDE_TITLE);
  await joinChannel(page, ROOM, ROOM_TITLE);

  const almond = await SimClient.connect(
    "almond@example.test",
    "hunter2",
    "Almond Fitch",
  );
  try {
    almond.send("JCH", { channel: ROOM });
    await delay(500);

    const nav = page.getByRole("navigation");
    const log = page.getByTestId("message-log");
    await seedReadBacklog(page, almond);

    // Step away to the other room, then take a few unreads in the one we left
    // — the reporter's exact shape: a handful, not a backlog.
    await nav.getByRole("link", { name: ASIDE_TITLE }).click();
    await expect(
      page.getByRole("heading", { name: ASIDE_TITLE }),
    ).toBeVisible();
    for (let i = 1; i <= 4; i += 1) {
      almond.send("MSG", {
        channel: ROOM,
        message: `while away #${String(i)}`,
      });
      await delay(150);
    }

    // Back to the channel: the newest message must be on screen, the divider
    // with it, and no pill inviting a scroll the user should not have to make.
    await nav.getByRole("link", { name: ROOM_TITLE }).click();
    await expect(page.getByRole("heading", { name: ROOM_TITLE })).toBeVisible();
    await expect(log.getByText("while away #4", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect
      .poll(() => dividerBelowFold(page), { timeout: 10_000 })
      .toBeLessThan(0);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();

    // It stays there: a late row re-measure must not walk the view back up.
    await delay(1500);
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(
      AT_BOTTOM_SLACK_PX,
    );
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
  } finally {
    almond.close();
  }
});

test("focus returning to a channel that took a few unreads lands at the tail (#411)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "seedwright@example.test", "Seedwright Vale");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const almond = await SimClient.connect(
    "almond@example.test",
    "hunter2",
    "Almond Fitch",
  );
  try {
    almond.send("JCH", { channel: ROOM });
    await delay(500);

    const log = page.getByTestId("message-log");
    await seedReadBacklog(page, almond);

    // Reload so the log mounts with the backlog already read: the "new since
    // you left" divider is frozen at attach, so it can only appear on a visit
    // that started with a read cursor behind the newest message.
    await page.reload();
    await expect(page.getByRole("heading", { name: ROOM_TITLE })).toBeVisible({
      timeout: 30_000,
    });
    await expect(log.getByText("seed A#30", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);

    // Away: the window loses focus while the conversation stays open — the
    // messages land with nobody looking, so they accrue instead of being
    // marked read (#440).
    await setWindowFocus(page, false);
    for (let i = 1; i <= 4; i += 1) {
      almond.send("MSG", {
        channel: ROOM,
        message: `unattended #${String(i)}`,
      });
      await delay(150);
    }
    await delay(1000);

    // Come back: the log has never unmounted, so nothing but the held
    // stick-to-bottom intent can have kept it on the newest messages.
    await setWindowFocus(page, true);
    await expect(log.getByText("unattended #4", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect
      .poll(() => dividerBelowFold(page), { timeout: 10_000 })
      .toBeLessThan(0);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
  } finally {
    almond.close();
  }
});
