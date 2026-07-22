// #284 regression: while the profile viewer (a modal overlay) obscures the
// chat, the message log must keep honoring the stick-to-bottom intent — new
// messages arriving behind the modal may not leave the user scrolled up
// (with the jump pill showing) when it closes. Owns marigold@example.test
// and the hidden Sun Porch room: spec files run in parallel, so specs never
// share characters or channels.

import { expect, test } from "@playwright/test";
import {
  delay,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
} from "./helpers.js";

const ROOM_ID = "ADH-284sunporch11aa22bb";
/** Enough messages to overflow the log's viewport several times over, so a
 * stalled bottom-stick leaves an unmistakable scroll gap. */
const BURST_COUNT = 40;
const BURST_SPACING_MS = 80;
/** Mirrors AT_BOTTOM_SLACK_PX in MessageLog — within this counts as bottom. */
const AT_BOTTOM_SLACK_PX = 60;

test("log keeps following new messages under the profile modal (#284)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "marigold@example.test", "Marigold Bell");
  await joinChannel(page, ROOM_ID, "Sun Porch");

  const wren = await SimClient.connect(
    "marigold@example.test",
    "hunter2",
    "Wren Salloway",
  );
  try {
    wren.send("JCH", { channel: ROOM_ID });
    const log = page.getByTestId("message-log");
    const members = page.getByRole("complementary", { name: "Members" });
    await expect(members.getByText("Wren Salloway")).toBeVisible();

    // Seed enough backlog that the log overflows and is genuinely
    // virtualized before the modal opens; the stick intent holds at the
    // bottom throughout.
    for (let i = 1; i <= BURST_COUNT; i += 1) {
      wren.send("MSG", { channel: ROOM_ID, message: `seed #${String(i)}` });
      await delay(BURST_SPACING_MS);
    }
    await expect(
      log.getByText(`seed #${String(BURST_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // ── Open Wren's profile the way a reader does: log nick → mini card →
    // full viewer. The modal overlays (not unmounts) the chat. ───────────
    await log.getByRole("button", { name: "Wren Salloway" }).last().click();
    const card = page.getByRole("dialog", {
      name: "Profile card: Wren Salloway",
    });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Open profile" }).click();
    const viewer = page.getByRole("dialog", { name: "Profile: Wren Salloway" });
    await expect(viewer).toBeVisible();

    // ── Messages pile up while the log sits behind the overlay ───────────
    for (let i = 1; i <= BURST_COUNT; i += 1) {
      wren.send("MSG", {
        channel: ROOM_ID,
        message: `under the modal #${String(i)}`,
      });
      await delay(BURST_SPACING_MS);
    }
    await expect(
      log.getByText(`under the modal #${String(BURST_COUNT)}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // ── Close the modal: the log is at the newest message, no jump pill ──
    await page.keyboard.press("Escape");
    await expect(viewer).not.toBeVisible();
    await expect
      .poll(
        () =>
          log.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(AT_BOTTOM_SLACK_PX);
    await expect(page.getByTestId("jump-to-recent")).not.toBeVisible();
  } finally {
    wren.close();
  }
});
