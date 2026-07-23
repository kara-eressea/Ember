// Message-log tail & unread-marker correctness against REAL scroll geometry
// (#372, #373). These reproduce three soak defects that slipped past component
// tests with mocked geometry, so they must run in a real browser against
// fchat-sim with live gateway state:
//   #372   — switching between two fully-read channels must land exactly at the
//            bottom (variable-height rows made the estimate-based mount stick
//            land short).
//   #373.1 — the "new messages" bar must stay hidden when the unreads already
//            fit on screen (only the in-log divider marks them).
//   #373.2 — Esc must remove the in-log "new since you left" divider even when
//            the bar is not shown (the common few-unreads case).
//
// Owns quill@example.test (Quill Marsh + Wick Marsh): spec files run in
// parallel and a character holds only one sim connection, so specs never share
// characters.

import { expect, test } from "@playwright/test";
import {
  delay,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
} from "./helpers.js";

/** Mirrors AT_BOTTOM_SLACK_PX in MessageLog — within this counts as bottom. */
const AT_BOTTOM_SLACK_PX = 60;

const ROOM_A = "ADH-372taila11bb22cc33";
const ROOM_A_TITLE = "Tail Room A";
const ROOM_B = "ADH-372tailb44dd55ee66";
const ROOM_B_TITLE = "Tail Room B";

/** A spread of lengths so rows measure much taller than the 26px estimate —
 * the exact condition that made the mount stick land short (#372). */
function seedLine(n: number): string {
  const long =
    "This is a deliberately long line that wraps across several rows in the " +
    "log so the measured height is well above the virtualizer's flat estimate. ";
  const body = n % 3 === 0 ? long.repeat(3) : n % 2 === 0 ? long : "short";
  return `A#${String(n)} ${body}`;
}

function distanceFromBottom(page: import("@playwright/test").Page) {
  return page
    .getByTestId("message-log")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test("switching between two fully-read channels lands at the bottom (#372)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "quill@example.test", "Quill Marsh");
  await joinChannel(page, ROOM_A, ROOM_A_TITLE);
  await joinChannel(page, ROOM_B, ROOM_B_TITLE);

  const reed = await SimClient.connect(
    "quill@example.test",
    "hunter2",
    "Wick Marsh",
  );
  try {
    reed.send("JCH", { channel: ROOM_A });
    reed.send("JCH", { channel: ROOM_B });
    await delay(500);

    // Enough variable-height backlog in each room to overflow the viewport
    // several times over, so a short landing is unmistakable. Spacing stays
    // above the sim's 50ms msg_flood so no line is throttled away.
    for (let i = 1; i <= 30; i += 1) {
      reed.send("MSG", { channel: ROOM_A, message: `RoomA ${seedLine(i)}` });
      await delay(70);
      reed.send("MSG", { channel: ROOM_B, message: `RoomB ${seedLine(i)}` });
      await delay(70);
    }

    const nav = page.getByRole("navigation");
    const log = page.getByTestId("message-log");

    // Read both rooms fully: open each and let it settle at the tail.
    for (const [title, tag] of [
      [ROOM_A_TITLE, "RoomA"],
      [ROOM_B_TITLE, "RoomB"],
    ] as const) {
      await nav.getByRole("link", { name: title }).click();
      await expect(log.getByText(`${tag} A#30`, { exact: false })).toBeVisible({
        timeout: 15_000,
      });
      await expect
        .poll(() => distanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    }

    // Now the actual defect: swap A → B → A. Each switch remounts the log and
    // must land at the bottom with no manual scroll — no pill, distance ~0.
    for (const title of [ROOM_A_TITLE, ROOM_B_TITLE, ROOM_A_TITLE]) {
      await nav.getByRole("link", { name: title }).click();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect
        .poll(() => distanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
      await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
    }
  } finally {
    reed.close();
  }
});

test("new-messages bar hides when unreads fit on screen; Esc clears the divider (#373)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "quill@example.test", "Quill Marsh");

  const reed = await SimClient.connect(
    "quill@example.test",
    "hunter2",
    "Wick Marsh",
  );
  try {
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Wick Marsh/ });
    const log = page.getByTestId("message-log");

    // A LONG, tall read backlog: enough long multi-line messages that most sit
    // scrolled off the top and stay unmeasured (flat 26px estimate) while the
    // divider rides near the bottom. That underestimate is what made
    // getOffsetForIndex place the on-screen divider "off-screen" and show the
    // bar with nothing to jump to (#373.1).
    reed.send("PRI", { recipient: "Quill Marsh", message: "baseline hello" });
    await dmRow.click();
    await expect(log.getByText("baseline hello")).toBeVisible();
    for (let i = 1; i <= 55; i += 1) {
      reed.send("PRI", {
        recipient: "Quill Marsh",
        message: `history ${seedLine(i)}`,
      });
      await delay(70);
    }
    await expect(log.getByText("history A#55", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // Detach; only a FEW messages arrive — few enough to fit on screen at the
    // tail, so the first unread (and its divider) is visible, not off-screen.
    await page.goto("about:blank");
    for (let i = 1; i <= 3; i += 1) {
      reed.send("PRI", {
        recipient: "Quill Marsh",
        message: `fresh #${String(i)}`,
      });
      await delay(120);
    }

    // Reattach and open the DM — opens at the tail (#370).
    await page.goto("/identities");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/app\//);
    await nav.getByRole("link", { name: /Wick Marsh/ }).click();
    await expect(log.getByText("fresh #3", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // #373.1: the unreads are all on screen → the divider marks them and the
    // jump bar must NOT show (nothing off-screen to jump to).
    await expect(page.getByTestId("new-divider")).toBeVisible();
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("new-messages-bar")).not.toBeVisible();

    // #373.2: Esc at the tail marks fully caught up — the divider leaves the
    // DOM (not just the bar).
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-divider")).toHaveCount(0);
  } finally {
    reed.close();
  }
});

test("new-messages bar shows and jumps when the unreads are off screen (#363/#373)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "quill@example.test", "Quill Marsh");

  const reed = await SimClient.connect(
    "quill@example.test",
    "hunter2",
    "Wick Marsh",
  );
  try {
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Wick Marsh/ });
    const log = page.getByTestId("message-log");

    // Read a baseline, then detach and let a LARGE backlog pile up — so the
    // first unread (the divider) lands well above the viewport at the tail.
    reed.send("PRI", { recipient: "Quill Marsh", message: "baseline hello" });
    await dmRow.click();
    await expect(log.getByText("baseline hello")).toBeVisible();

    await page.goto("about:blank");
    for (let i = 1; i <= 40; i += 1) {
      reed.send("PRI", {
        recipient: "Quill Marsh",
        message: `away ${seedLine(i)}`,
      });
      await delay(70);
    }

    await page.goto("/identities");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/app\//);
    await nav.getByRole("link", { name: /Wick Marsh/ }).click();
    await expect(log.getByText("away A#40", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // Opens at the tail with the divider off screen → the bar shows the count.
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    const bar = page.getByTestId("new-messages-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("new messages since you left");

    // Clicking it jumps up to the first unread: the divider comes on screen and
    // the back-to-present pill appears.
    await bar.click();
    await expect(page.getByTestId("new-divider")).toBeVisible();
    await expect(page.getByTestId("jump-to-recent")).toBeVisible();
    // Having engaged catch-up, the bar does not re-show on return to the tail.
    await page.getByTestId("jump-to-recent").click();
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(bar).not.toBeVisible();
  } finally {
    reed.close();
  }
});
