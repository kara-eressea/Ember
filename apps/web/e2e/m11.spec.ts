// The M11 campaigns + ratings E2E: author a tagged ad, start a rotation
// campaign through the Rotate… slot (setup → status), watch a real post
// land in the log under the shrunken sim-only timings, see the channel
// pause when its window closes, stop everything (kill switch), renew, and
// then rate another poster's ad (editor popover, stars on later ads, the
// ≤2★ collapse with in-place expand). Owns linden@example.test (Linden
// Frost; Orsolya is the raw-SimClient "other side") and the hidden
// Borealis Lounge room — spec files run in parallel, so specs never share
// characters or channels.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

const BOREALIS = "ADH-m11borealis33aa44bb";
const POLAR = "ADH-m11polar55cc66dd77";

test("M11: campaign start → live post → window pause → kill → renew; rate a poster and collapse their ads", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "linden@example.test", "Linden Frost");

  // Join the two hidden both-mode rooms by exact id.
  for (const [key, title] of [
    [BOREALIS, "Borealis Lounge"],
    [POLAR, "Polar Court"],
  ] as const) {
    await page.getByRole("button", { name: "Browse channels" }).click();
    const browser = page.getByRole("dialog", { name: "Browse channels" });
    await browser.getByLabel("Join a hidden channel by name").fill(key);
    await browser.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }

  // ── Author one tagged ad ───────────────────────────────────────────────
  await page.getByRole("button", { name: "Open the Ad Center" }).click();
  const adCenter = page.getByRole("dialog", { name: "Ad Center" });
  await adCenter.getByRole("button", { name: "Write your first ad" }).click();
  await adCenter
    .getByRole("textbox", { name: "Ad text" })
    .fill("**Snow leopard** looks for aurora-lit scenes.");
  await adCenter.getByRole("textbox", { name: "Add tag" }).fill("aurora");
  await adCenter.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await adCenter.getByRole("button", { name: "Save ad" }).click();
  await expect(adCenter.getByText("Saved", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // ── Close Borealis's ad window with a MANUAL post first ──────────────
  // The scheduler schedules around its own window, so a campaign never
  // collides with itself — the visible refusal needs the window closed
  // from elsewhere, which is exactly what a manual post is.
  await page.getByRole("button", { name: "Open the Ad Center" }).click();
  await adCenter.getByRole("button", { name: "Post ads…" }).click();
  const postDialog = page.getByRole("dialog", { name: "Post ads" });
  await postDialog.getByRole("radio", { name: /Snow leopard/ }).click();
  await postDialog.getByRole("button", { name: /Borealis Lounge/ }).click();
  await postDialog.getByRole("button", { name: "Post now" }).click();
  await expect(postDialog.getByText("Posted to 1 of 1")).toBeVisible({
    timeout: 15_000,
  });
  // The results screen has no Rotate slot — Done drops back to the still-
  // open Ad Center; reopen the pick screen from there.
  await postDialog.getByRole("button", { name: "Done" }).click();
  await adCenter.getByRole("button", { name: "Post ads…" }).click();

  // ── Campaign setup through the live Rotate… slot ──────────────────────
  await postDialog.getByRole("button", { name: "↻ Rotate…" }).click();
  const setup = page.getByRole("dialog", { name: "Set up a campaign" });
  await setup.getByRole("button", { name: /aurora/ }).click();
  await expect(setup.getByText("1 ad will rotate")).toBeVisible();
  await expect(setup.getByText("↺ back to 1")).toBeVisible();
  await setup.getByRole("button", { name: /Borealis Lounge/ }).click();
  await setup.getByRole("button", { name: /Polar Court/ }).click();
  await expect(setup.getByText("Runs for 1 hour, then stops")).toBeVisible();
  await setup.getByRole("button", { name: "Start campaign" }).click();

  // ── Status: live; Polar takes a real rotation post, Borealis pauses ──
  const status = page.getByRole("dialog", { name: "Campaign", exact: true });
  await expect(status.getByText("Posting live")).toBeVisible();
  await expect(status.getByText(/expires in/)).toBeVisible();
  await expect(
    status.getByText(
      "This channel got an ad from somewhere else — waiting out its window.",
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(status.getByText(/retry ≈/)).toBeVisible();
  await expect(status.getByText(/next ≈/)).toBeVisible({ timeout: 20_000 });
  // The Ad Center is still stacked under the campaign dialog.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ad Center" })).toBeHidden();
  await page.getByRole("link", { name: /Polar Court/ }).click();
  await expect(
    page.locator("[data-ad]").filter({ hasText: "Snow leopard" }).first(),
  ).toBeVisible({ timeout: 20_000 });

  // The channel header carries the quiet live-campaign chip.
  await expect(
    page.getByRole("button", { name: /Campaign · posting here/ }),
  ).toBeVisible();

  // ── Kill switch, then renew ───────────────────────────────────────────
  await page.getByRole("button", { name: "Open the Ad Center" }).click();
  await adCenter.getByRole("button", { name: "Post ads…" }).click();
  await page
    .getByRole("dialog", { name: "Post ads" })
    .getByRole("button", { name: /Campaign live/ })
    .click();
  await status.getByRole("button", { name: "■ Stop everything" }).click();
  await expect(
    status.getByText("Campaign stopped — posting has stopped"),
  ).toBeVisible();
  // The run summary reports what went out per channel.
  await expect(status.getByText("What went out")).toBeVisible();
  await expect(status.getByText("1 post", { exact: true })).toBeVisible();
  await expect(status.getByText("0 posts", { exact: true })).toBeVisible();
  await status.getByRole("button", { name: "↻ Renew for 1 hour" }).click();
  await expect(status.getByText("Posting live")).toBeVisible();
  await status.getByRole("button", { name: "■ Stop everything" }).click();
  await expect(
    status.getByText("Campaign stopped — posting has stopped"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ad Center" })).toBeHidden();

  // ── Ratings: Orsolya posts ads; rate her, watch the collapse ─────────
  const orsolya = await SimClient.connect(
    "linden@example.test",
    "hunter2",
    "Orsolya",
  );
  orsolya.send("JCH", { channel: BOREALIS });
  await orsolya.waitFor(
    "JCH",
    (payload: { character: { identity: string } }) =>
      payload.character.identity === "Orsolya",
  );
  orsolya.send("LRP", {
    channel: BOREALIS,
    message: "Wolfhound seeks winter partners.",
  });
  // The log under test is Borealis — we were still on Polar Court.
  await page.getByRole("link", { name: /Borealis Lounge/ }).click();
  const orsolyaAd = page
    .locator("[data-ad]")
    .filter({ hasText: "Wolfhound seeks winter partners." });
  await expect(orsolyaAd).toBeVisible();

  // Hover reveals the quiet Rate pill; the editor saves on star pick.
  await orsolyaAd.hover();
  await orsolyaAd.getByRole("button", { name: "Rate Orsolya" }).click();
  const editor = page.getByRole("dialog", { name: "Rate Orsolya" });
  await expect(
    editor.getByText("saved on this server only · never sent to F-List"),
  ).toBeVisible();
  await editor
    .getByRole("textbox", { name: "Private note" })
    .fill("kept ghosting mid-scene");
  await editor.getByRole("radio", { name: "2 stars" }).click();
  // A ≤2★ pick collapses the ad right behind the editor — that collapse
  // IS the visible save feedback (the editor remounts with the stub, so
  // the transient "Saved ✓" flag doesn't survive; ≥3★ picks keep it).
  await expect(editor.getByRole("radio", { name: "2 stars" })).toBeChecked();
  await page.keyboard.press("Escape");

  // The rated ad is already collapsed to the dimmed stub…
  orsolya.send("LRP", {
    channel: BOREALIS,
    message: "Second call for winter partners.",
  });
  const stub = page.getByRole("button", {
    name: /Show the ad from Orsolya/,
  });
  await expect(stub.first()).toBeVisible();
  await expect(
    stub.first().getByText("“kept ghosting mid-scene”"),
  ).toBeVisible();
  // …and expands in place with the note surfaced.
  await stub.first().click();
  await expect(page.getByText("YOUR NOTE")).toBeVisible();

  await orsolya.close();
});
