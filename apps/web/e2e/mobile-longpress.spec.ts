// Long-press action sheets on a real touch context (MP2 §1, #376). Runs in
// the `mobile-chromium` project, and the device descriptor is load-bearing
// twice over: `hover: none` is what gates the recognizer at all, and a real
// touch pointer is what makes `pointerdown` arrive with pointerType "touch".
// A desktop project resized to 393px would hover, and its pointer would be a
// mouse — the recognizer would attach nothing and this file would pass by
// doing nothing.
//
// The hold itself is CDP (long-press.ts), because Playwright's touchscreen API
// only taps. Which is also what makes the drag case meaningful — the same
// primitive, with movement in the middle.
//
// Owns holt@example.test (Holt Barrow) and marlaquinn@example.test (Marla
// Quinn): spec files run in parallel and a character holds one sim
// connection, so specs share neither.

import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";
import { longPress, slowDrag } from "./long-press.js";

const PARTNER = "Marla Quinn";
const EICON = "tearsofjoy";

test("phone device: a hold opens the action sheet, a drag does not (#376)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "holt@example.test", "Holt Barrow");
  const cdp = await page.context().newCDPSession(page);

  const partner = await SimClient.connect(
    "marlaquinn@example.test",
    "hunter2",
    PARTNER,
  );
  try {
    // ── A message with an eicon in it, so there is something to hold ──────
    partner.send("PRI", {
      recipient: "Holt Barrow",
      message: `Found you [eicon]${EICON}[/eicon]`,
    });

    const sidebar = page
      .getByRole("navigation")
      .filter({ has: page.getByLabel("Filter the channel list") });
    await sidebar
      .getByRole("link", { name: new RegExp(PARTNER) })
      .click({ timeout: 15_000 });
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "conversation",
    );

    const log = page.getByTestId("message-log");
    const eicon = log.getByRole("img", { name: EICON });
    await expect(eicon).toBeVisible({ timeout: 15_000 });

    // ── A drag is a scroll, and opens nothing ────────────────────────────
    // The whole reason the recognizer watches for movement: this gesture
    // starts on a claimed element and lasts far longer than the hold
    // threshold, and it still has to be a scroll.
    await slowDrag(cdp, page, eicon);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // ── A hold opens the sheet ───────────────────────────────────────────
    await longPress(cdp, page, eicon);
    const sheet = page.getByRole("dialog", { name: `${EICON} eicon menu` });
    await expect(sheet).toBeVisible();
    // The phone shape, not the anchored popover: full width, at the bottom.
    const box = await sheet.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.width).toBeCloseTo(viewport?.width ?? 0, 0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(
      viewport?.height ?? 0,
      0,
    );
    // …naming its target, and offering the same items the right-click menu
    // does, in the same order.
    await expect(sheet).toContainText(EICON);
    await expect(sheet.getByRole("menuitem")).toHaveText([
      "Favourite",
      "Block",
      "Copy name",
    ]);
    // Every row is a thumb-sized target.
    for (const item of await sheet.getByRole("menuitem").all()) {
      expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }

    // ── Backdrop tap puts it away ────────────────────────────────────────
    await page.touchscreen.tap(10, 10);
    await expect(sheet).toHaveCount(0);

    // ── …and an action works end to end ──────────────────────────────────
    // Block round-trips through the server's prefs and comes back as a fan-
    // out, so the image being replaced by the name chip is the whole path.
    await longPress(cdp, page, eicon);
    await expect(sheet).toBeVisible();
    await sheet.getByRole("menuitem", { name: "Block" }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(log.getByRole("img", { name: EICON })).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(log.getByTitle(`${EICON} — blocked eicon`)).toBeVisible();

    // ── The menu is still reachable from the chip that replaced it ───────
    // Which is how it gets unblocked — the only path back on a touchscreen.
    await longPress(cdp, page, log.getByTitle(`${EICON} — blocked eicon`));
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("menuitem", { name: "Unblock" }),
    ).toBeVisible();
  } finally {
    partner.close();
  }
});
