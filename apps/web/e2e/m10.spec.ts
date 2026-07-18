// The M10 ads + search E2E: author an ad in the Ad Center (lossiness
// warning, tags), post it through the manual flow (cadence hint, per-
// channel outcome, cooldown row afterwards), see the distinct ad block in
// the log with ads never counting toward unread, then search characters by
// kink, open the mini card from a result, and rerun a saved search for the
// "N new" badge. Owns vesna@example.test (Vesna Marlowe; Kolvarr is the
// raw-SimClient "other side") and the hidden Aurora Den room — spec files
// run in parallel, so specs never share characters or channels.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

const AURORA = "ADH-m10aurora00dd11ee22ff";

test("M10: author → post → distinct ad render; kink search with saved rerun diff", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "vesna@example.test", "Vesna Marlowe");

  // Join the hidden both-mode room by exact id through the browser footer.
  await page.getByRole("button", { name: "Browse channels" }).click();
  const browser = page.getByRole("dialog", { name: "Browse channels" });
  await browser.getByLabel("Join a hidden channel by name").fill(AURORA);
  await browser.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Aurora Den" })).toBeVisible();

  // ── Author: the Ad Center off the composer's Ad button ────────────────
  await page.getByRole("button", { name: "Open the Ad Center" }).click();
  const adCenter = page.getByRole("dialog", { name: "Ad Center" });
  await adCenter.getByRole("button", { name: "Write your first ad" }).click();
  await adCenter
    .getByRole("textbox", { name: "Ad text" })
    .fill(
      "**Arctic fox** seeks slow-burn scenes.\n# not a heading on the wire",
    );
  // The advisory lossiness strip flags the heading — and never blocks.
  await expect(adCenter.getByText("will post as plain text")).toBeVisible();
  await adCenter.getByRole("textbox", { name: "Add tag" }).fill("winter");
  await adCenter.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await adCenter.getByRole("button", { name: "Save ad" }).click();
  await expect(adCenter.getByText("Saved", { exact: true })).toBeVisible();

  // ── Post: pick the ad, pick the channel (cadence hint shown), post ────
  await adCenter.getByRole("button", { name: "Post ads…" }).click();
  const postDialog = page.getByRole("dialog", { name: "Post ads" });
  await postDialog.getByRole("button", { name: /Arctic fox/ }).click();
  const auroraRow = postDialog.getByRole("button", { name: /Aurora Den/ });
  await expect(auroraRow).toContainText("15m"); // parsed [ads: 15 min]
  await auroraRow.click();
  await postDialog.getByRole("button", { name: "Post now" }).click();
  await expect(postDialog.getByText("Posted to 1 of 1")).toBeVisible({
    timeout: 15_000,
  });
  // The channel is now inside its window: reopening shows the cooldown row.
  await postDialog.getByRole("button", { name: "Done" }).click();
  await adCenter.getByRole("button", { name: "Post ads…" }).click();
  // The only eligible channel is inside its window now, so the dialog
  // lands on the everything-waiting edge state with the earliest opening.
  await expect(
    page
      .getByRole("dialog", { name: "Post ads" })
      .getByText("Everything is waiting"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape"); // close the Ad Center too

  // ── Render: the ad is a distinct block, and never counts as unread ────
  const ownAd = page.locator("[data-ad]").filter({ hasText: "Arctic fox" });
  await expect(ownAd).toBeVisible({ timeout: 15_000 });
  await expect(ownAd.getByText("AD", { exact: true })).toBeVisible();

  // Kolvarr comes online in the room as the "other side".
  const kolvarr = await SimClient.connect(
    "vesna@example.test",
    "hunter2",
    "Kolvarr",
  );
  kolvarr.send("JCH", { channel: AURORA });
  await kolvarr.waitFor(
    "JCH",
    (p: { character: { identity: string } }) =>
      p.character.identity === "Kolvarr",
  );

  // Open a DM with Kolvarr so Aurora Den is NOT the active conversation,
  // then: his ad must not badge the channel row; his chat message must.
  const members = page.getByRole("complementary", { name: "Members" });
  await expect(members.getByText("Kolvarr")).toBeVisible({ timeout: 15_000 });
  await members.getByText("Kolvarr").click({ button: "right" });
  await page
    .getByRole("menu", { name: "Kolvarr menu" })
    .getByRole("menuitem", { name: "Message" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Kolvarr" }).first(),
  ).toBeVisible();
  const auroraNav = page.getByRole("link", { name: /Aurora Den/ }).first();
  kolvarr.send("LRP", { channel: AURORA, message: "Northern lights tour." });
  // The ad reached the buffer (flipping back would show it) but no badge.
  await page.waitForTimeout(2000);
  await expect(auroraNav.getByTestId("nav-badge")).not.toBeVisible();
  kolvarr.send("MSG", { channel: AURORA, message: "hello from the den" });
  await expect(auroraNav.getByTestId("nav-badge")).toBeVisible({
    timeout: 15_000,
  });

  // ── Search: kink picker → results → mini card → saved rerun diff ──────
  await page.getByRole("button", { name: "Search characters" }).click();
  const search = page.getByRole("dialog", { name: "Search characters" });
  await search.getByRole("button", { name: "+ Add kinks…" }).click();
  await search.getByRole("textbox", { name: "Search kinks" }).fill("Campfire");
  await search.getByRole("button", { name: /Campfire Stories/ }).click();
  await search.getByRole("button", { name: "Done" }).click();

  // Kolvarr disconnects first so the initial run finds only Nyx (NPC).
  kolvarr.close();
  await page.waitForTimeout(1000);
  await search.getByRole("button", { name: "Search", exact: true }).click();
  const nyxRow = search.getByRole("button", { name: /Nyx Firemane/ });
  await expect(nyxRow).toBeVisible({ timeout: 15_000 });
  await expect(
    search.getByRole("button", { name: /Kolvarr/ }),
  ).not.toBeVisible();

  // Save the search, bring Kolvarr back online, rerun → "1 new".
  await search.getByRole("button", { name: "☆ Save current" }).click();
  await search
    .getByRole("textbox", { name: "Saved search name" })
    .fill("Campfire folk");
  await search
    .getByRole("textbox", { name: "Saved search name" })
    .press("Enter");
  await expect(search.getByText("Campfire folk")).toBeVisible();

  const kolvarr2 = await SimClient.connect(
    "vesna@example.test",
    "hunter2",
    "Kolvarr",
  );
  // The pace allows one search per 5s — wait for the button to free up.
  const again = search.getByRole("button", { name: "Search again" });
  await expect(again).toBeEnabled({ timeout: 15_000 });
  await again.click();
  await expect(search.getByRole("button", { name: /Kolvarr/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(search.getByText("1 new")).toBeVisible();

  // A result row opens the mini profile card (z-stacked over the dialog).
  await search.getByRole("button", { name: /Nyx Firemane/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Profile card: Nyx Firemane" }),
  ).toBeVisible();

  kolvarr2.close();
});
