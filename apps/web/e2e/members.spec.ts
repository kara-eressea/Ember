// The #200 "Seen recently" E2E: a member who parts a channel appears under
// the member list's Seen recently fold (collapsed by default), expanding
// shows the row with its relative time, the filter finds offline members,
// and a rejoin moves the nick back to the online groups.
// Owns clover@example.test (Clover Hart + Dell Marsh) and Fallow Field —
// spec files run in parallel and a character can hold only one sim
// connection, so specs never share accounts or channels.

import { expect, test } from "@playwright/test";
import {
  SimClient,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

const CHANNEL_KEY = "ADH-200fallow88ee99ff00";
const CHANNEL_TITLE = "Fallow Field";

test("seen recently: part → fold appears, expand, filter, rejoin clears", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "clover@example.test", "Clover Hart");
  await joinChannel(page, CHANNEL_KEY, CHANNEL_TITLE);

  const members = page.getByRole("complementary", { name: "Members" });
  // No history yet: the fold does not exist at all (an empty labelled fold
  // would read as broken).
  await expect(
    members.getByRole("button", { name: /Seen recently/ }),
  ).toHaveCount(0);

  // The other side joins…
  const dell = await SimClient.connect(
    "clover@example.test",
    "hunter2",
    "Dell Marsh",
  );
  dell.send("JCH", { channel: CHANNEL_KEY });
  await expect(
    members.getByRole("listitem").filter({ hasText: "Dell Marsh" }),
  ).toBeVisible({ timeout: 15_000 });

  // …and parts: the nick leaves the online roster and the fold materializes,
  // collapsed, with its count.
  dell.send("LCH", { channel: CHANNEL_KEY });
  const fold = members.getByRole("button", { name: /Seen recently/ });
  await expect(fold).toBeVisible({ timeout: 15_000 });
  await expect(fold).toContainText("1");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(
    members.getByRole("listitem").filter({ hasText: "Dell Marsh" }),
  ).toHaveCount(0);

  // Expand: the offline row renders with a plain-language relative time.
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const offlineRow = members
    .getByRole("listitem")
    .filter({ hasText: "Dell Marsh" });
  await expect(offlineRow).toBeVisible();
  await expect(offlineRow).toContainText("just now");

  // Collapse again, then find the offline member through the filter — the
  // group auto-expands while a query is active and the count reads
  // "{matches} of {total}".
  await fold.click();
  await expect(offlineRow).toHaveCount(0);
  await page.getByLabel("Filter members").fill("dell");
  await expect(offlineRow).toBeVisible();
  await expect(fold).toContainText("1 of 1");
  await page.getByLabel("Filter members").fill("");
  // Clearing the query restores the remembered collapsed state.
  await expect(offlineRow).toHaveCount(0);

  // Rejoin: back into the online roster, and with no seen entries left the
  // fold disappears entirely.
  dell.send("JCH", { channel: CHANNEL_KEY });
  await expect(
    members.getByRole("listitem").filter({ hasText: "Dell Marsh" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(fold).toHaveCount(0);

  dell.close();
});
