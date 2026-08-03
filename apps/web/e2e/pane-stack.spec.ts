// The phone single-pane navigation stack (#375, MP1 package B) against real
// browser geometry: the route picks the pane, back is a route change, the
// identity rail folds into the list header — and, the part component tests
// cannot answer, the message log survives the width changes all of that
// implies. A pane switch is the largest width change the log ever sees (it
// gains or loses the whole sidebar), and every remembered row height is a
// function of that width (#460), so this is where the tail invariants
// (#266 / #372 / #454 / #464) are most likely to break.
//
// This runs in the ordinary Chromium project and merely resizes the viewport;
// a dedicated mobile project with device emulation is MP1 package G.
//
// Owns pane@example.test (Pane Hollow), stackfell@example.test (Stack Fell)
// and the Pane Room channel: spec files run in parallel and a character holds
// one sim connection, so specs share neither.

import { type Locator, type Page } from "@playwright/test";
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

const ROOM = "ADH-375panestack11aa22bb";
const ROOM_TITLE = "Pane Room";

/** A common phone: iPhone 14 / Pixel-class logical pixels, portrait. */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

/** A spread of lengths so rows measure far taller than the flat 26px estimate
 * — and so they re-wrap dramatically when the pane switch changes the log's
 * width, which is exactly what a stale measurement cache gets wrong. */
function seedLine(n: number): string {
  const long =
    "This is a deliberately long line that wraps across several rows in the " +
    "log so the measured height is well above the virtualizer's flat estimate. ";
  const body = n % 3 === 0 ? long.repeat(3) : n % 2 === 0 ? long : "short";
  return `Line ${String(n)} ${body}`;
}

function distanceFromBottom(page: Page) {
  return page
    .getByTestId("message-log")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (b === null) {
    throw new Error("element has no bounding box");
  }
  return b;
}

/** The page must never scroll sideways on a phone — a single overflowing row
 * is the classic way a "responsive" shell stops being one. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("phone: the route drives the pane stack, and the log stays at the tail across every switch (#375)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "pane@example.test", "Pane Hollow");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const partner = await SimClient.connect(
    "stackfell@example.test",
    "hunter2",
    "Stack Fell",
  );
  try {
    partner.send("JCH", { channel: ROOM });
    await delay(500);
    // Enough variable-height backlog to overflow a phone viewport several
    // times over, so a short landing is unmistakable. Spacing stays above the
    // sim's 50ms msg_flood so no line is throttled away.
    for (let i = 1; i <= 30; i += 1) {
      partner.send("MSG", { channel: ROOM, message: seedLine(i) });
      await delay(70);
    }

    const shell = page.getByTestId("app-shell");
    const rail = page.getByRole("navigation", { name: "Identities" });
    const sidebar = page
      .getByRole("navigation")
      .filter({ has: page.getByLabel("Filter the channel list") });
    const log = page.getByTestId("message-log");
    const back = page.getByRole("link", { name: "Back to conversations" });
    const roomRow = sidebar.getByRole("link", { name: new RegExp(ROOM_TITLE) });

    await expect(log.getByText("Line 30", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);

    // ── Desktop: no stack at all, both columns on screen ─────────────────
    await expect(shell).not.toHaveAttribute("data-pane");
    await expect(sidebar).toBeVisible();
    await expect(back).toHaveCount(0);
    const desktopLogWidth = (await box(log)).width;

    // ── Cross the boundary with the conversation open ────────────────────
    // The rotate/resize case: no navigation happens, the tier changes under a
    // mounted log, and the log's content width jumps by the sidebar's width.
    await page.setViewportSize(PHONE);
    await expect(shell).toHaveAttribute("data-pane", "conversation");
    await expect(sidebar).toBeHidden();
    await expect(rail).toBeHidden();
    await expect(back).toBeVisible();
    // The conversation really did take the whole pane.
    expect((await box(log)).width).toBeLessThan(desktopLogWidth);
    expect((await box(log)).width).toBeGreaterThan(PHONE.width - 40);
    // …and the flip did not strand it off the tail.
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // ── Back → the list pane, at the canonical identity path ─────────────
    await back.click();
    // Canonical on arrival: no second <Navigate replace> fires, and nothing
    // bounces the bare identity route back into the last conversation.
    await expect(page).toHaveURL(/\/app\/Pane(%20|\+)Hollow$/);
    await expect(shell).toHaveAttribute("data-pane", "list");
    await expect(sidebar).toBeVisible();
    await expect(log).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The rail folded into the list pane's header: a full-width strip above
    // the conversation list, not a 60px column beside it.
    await expect(rail).toBeVisible();
    const railBox = await box(rail);
    const sidebarBox = await box(sidebar);
    expect(railBox.width).toBeGreaterThan(PHONE.width - 40);
    expect(railBox.height).toBeLessThan(100);
    expect(railBox.y + railBox.height).toBeLessThanOrEqual(sidebarBox.y + 2);
    expect(sidebarBox.width).toBeGreaterThan(PHONE.width - 40);
    // A rail tap on the stack goes to that identity's list — the rail is the
    // list's own header here, so it must not teleport past it into whatever
    // conversation was open last (which the visit above just recorded).
    await expect(rail.getByTestId("rail-item")).toHaveAttribute(
      "href",
      /\/app\/Pane(%20|\+)Hollow$/,
    );

    // ── Forward again by tapping a row: still lands at the tail ──────────
    await roomRow.click();
    await expect(shell).toHaveAttribute("data-pane", "conversation");
    await expect(log.getByText("Line 30", { exact: false })).toBeVisible();
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);

    // ── The browser's own Back walks the stack, no interception ──────────
    await page.goBack();
    await expect(shell).toHaveAttribute("data-pane", "list");
    await page.goForward();
    await expect(shell).toHaveAttribute("data-pane", "conversation");

    // ── A cold load of the deep link opens on the conversation pane ──────
    await page.reload();
    await expect(shell).toHaveAttribute("data-pane", "conversation", {
      timeout: 20_000,
    });
    await expect(log.getByText("Line 30", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);

    // ── Back over the boundary: the desktop grid, unchanged ──────────────
    await page.setViewportSize(DESKTOP);
    await expect(shell).not.toHaveAttribute("data-pane");
    await expect(sidebar).toBeVisible();
    await expect(rail).toBeVisible();
    await expect(back).toHaveCount(0);
    const restoredLogWidth = (await box(log)).width;
    expect(restoredLogWidth).toBeGreaterThan(desktopLogWidth - 5);
    expect(restoredLogWidth).toBeLessThan(desktopLogWidth + 5);
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);
  } finally {
    partner.close();
  }
});
