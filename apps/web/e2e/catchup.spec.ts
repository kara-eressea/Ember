// History catch-up (#254): the browser detaches, a DM backlog piles up on
// the bouncer, and the reattached client shows the "new since you left"
// divider and can scroll back through the full stored history (gateway
// history.page). DMs behave identically to channels, so the DM flow stands
// in for both. Owns ember@example.test (Ember Hollis + Coal Whitby): spec
// files run in parallel and a character can hold only one sim connection,
// so specs never share characters.

import { expect, test } from "@playwright/test";
import {
  SimClient,
  delay,
  interceptAvatars,
  provisionAndConnect,
} from "./helpers.js";

/** More than one REST/gateway page (50), so catch-up needs real paging. */
const WAVE_COUNT = 60;
/** Small gap between sim sends so the relay never floods. */
const WAVE_SPACING_MS = 25;

test("detach → backlog → reattach: divider and full scroll-back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "ember@example.test", "Ember Hollis");

  const coal = await SimClient.connect(
    "ember@example.test",
    "hunter2",
    "Coal Whitby",
  );
  try {
    // A first message, read while attached — this is the last-seen point.
    coal.send("PRI", { recipient: "Ember Hollis", message: "hello there" });
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Coal Whitby/ });
    await dmRow.click();
    const log = page.getByTestId("message-log");
    await expect(log.getByText("hello there")).toBeVisible();

    // ── Detach: leave the app entirely; the bouncer holds the session ────
    await page.goto("about:blank");
    for (let i = 1; i <= WAVE_COUNT; i += 1) {
      coal.send("PRI", {
        recipient: "Ember Hollis",
        message: `wave #${String(i)}`,
      });
      await delay(WAVE_SPACING_MS);
    }

    // ── Reattach: the snapshot badge carries the backlog, the reopened DM
    //    lands on the newest message ────────────────────────────────────────
    await page.goto("/identities");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/app\//);
    await nav.getByRole("link", { name: /Coal Whitby/ }).click();
    await expect(
      log.getByText(`wave #${String(WAVE_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Scroll to the top repeatedly; each pass pages older history in until
    // the divider marking "since you were last here" — and beyond it, the
    // message read before detaching — is on screen.
    await expect(async () => {
      await log.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(page.getByTestId("new-divider")).toBeVisible({
        timeout: 1_000,
      });
      await expect(log.getByText("hello there")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });
    await expect(log.getByText("wave #1", { exact: true })).toBeVisible();

    // Escape jumps back to the newest message and marks everything read.
    await page.keyboard.press("Escape");
    await expect(
      log.getByText(`wave #${String(WAVE_COUNT)}`, { exact: true }),
    ).toBeVisible();
    await expect(dmRow.getByTestId("nav-badge")).toHaveCount(0);
  } finally {
    coal.close();
  }
});
