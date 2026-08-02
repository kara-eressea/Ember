// The M11 campaigns + ratings E2E: author a tagged ad, start a rotation
// campaign through the Rotate… slot (setup → status), watch a real post
// land in the log under the shrunken sim-only timings, see the channel
// pause when its window closes, stop everything (kill switch), renew, and
// then rate another poster's ad (editor popover, stars on later ads, the
// ≤2★ collapse with in-place expand). A second test in this file — same
// worker, so the same character is never held twice — covers the
// `campaign.updated` fan-out across two devices on one identity.
// Owns linden@example.test (Linden Frost),
// orsolya@example.test (the raw-SimClient "other side") and the hidden
// Borealis Lounge room: specs never share an account, a character, or a
// channel.

import {
  expect,
  expectCharacterOnline,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

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
  await expect(status.getByText("Posting live", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: /^Campaign$/ })).toBeVisible();

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
  await expect(status.getByText("Posting live", { exact: true })).toBeVisible();
  await status.getByRole("button", { name: "■ Stop everything" }).click();
  await expect(
    status.getByText("Campaign stopped — posting has stopped"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ad Center" })).toBeHidden();

  // ── Ratings: Orsolya posts ads; rate her, watch the collapse ─────────
  const orsolya = await SimClient.connect(
    "orsolya@example.test",
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

  // The Rate pill is invisible until its row is hovered — and a keyboard
  // reader gets the same reveal from :focus-visible (ratings.module.css §6).
  // Only a real keyboard focus answers that selector, so tab in from the
  // row's own nick button rather than focusing the pill by script.
  const pill = orsolyaAd.getByRole("button", { name: "Rate Orsolya" });
  const pillOpacity = () =>
    pill.evaluate((el) => globalThis.getComputedStyle(el).opacity);
  await expect.poll(pillOpacity).toBe("0");
  await orsolyaAd.getByRole("button", { name: "Orsolya", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(pill).toBeFocused();
  await expect.poll(pillOpacity).toBe("1");

  // Hover reveals the same pill; the editor saves on star pick.
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

  orsolya.close();
});

// A campaign belongs to the server-held session, not to the browser that
// started it (M11 `campaign.updated` fan-out). Two devices on one identity:
// whatever one does to the run, the other's open campaign surface has to
// follow without a reload — including the flip from the setup surface to the
// status one, which is where a stale second device would otherwise sit
// offering to start a campaign that already exists.
//
// Same file as the campaign journey above, so it runs in the same worker:
// linden@example.test and Linden Frost are never held by two tests at once.
test("M11: campaign.updated converges across two devices on one identity", async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);
  const creds = await provisionAndConnect(
    page,
    "linden@example.test",
    "Linden Frost",
  );
  await joinChannel(page, POLAR, "Polar Court");

  // Device A writes the ad the campaign will rotate.
  await page.getByRole("button", { name: "Open the Ad Center" }).click();
  const adCenter = page.getByRole("dialog", { name: "Ad Center" });
  await adCenter.getByRole("button", { name: "Write your first ad" }).click();
  await adCenter
    .getByRole("textbox", { name: "Ad text" })
    .fill("**Snow leopard** waits by the ice pillars.");
  await adCenter.getByRole("textbox", { name: "Add tag" }).fill("aurora");
  await adCenter.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await adCenter.getByRole("button", { name: "Save ad" }).click();
  await expect(adCenter.getByText("Saved", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  /** Ad Center → Post ads… → the Rotate… slot, i.e. the campaign surface. */
  const openCampaign = async (device: typeof page) => {
    await device.getByRole("button", { name: "Open the Ad Center" }).click();
    await device
      .getByRole("dialog", { name: "Ad Center" })
      .getByRole("button", { name: "Post ads…" })
      .click();
    await device
      .getByRole("dialog", { name: "Post ads" })
      .getByRole("button", { name: "↻ Rotate…" })
      .click();
  };

  const contextB = await browser.newContext();
  try {
    // ── Device B attaches to the same server-held session ────────────────
    const pageB = await contextB.newPage();
    await interceptAvatars(pageB);
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(creds.email);
    await pageB.getByLabel("Password").fill(creds.password);
    await pageB.getByRole("button", { name: "Log in" }).click();
    await pageB.getByRole("button", { name: "Open", exact: true }).click();
    await expect(pageB).toHaveURL(/\/app\//);
    await expectCharacterOnline(pageB, "Linden Frost");
    // The Ad Center entry lives on the composer, so B needs a conversation
    // open — the channel A joined is already in this identity's sidebar.
    await pageB.getByRole("link", { name: /Polar Court/ }).click();

    // …and parks on the campaign surface. No campaign yet → setup.
    await openCampaign(pageB);
    await expect(
      pageB.getByRole("dialog", { name: "Set up a campaign" }),
    ).toBeVisible();

    // ── Device A starts one ──────────────────────────────────────────────
    await openCampaign(page);
    const setupA = page.getByRole("dialog", { name: "Set up a campaign" });
    await setupA.getByRole("button", { name: /aurora/ }).click();
    await setupA.getByRole("button", { name: /Polar Court/ }).click();
    await setupA.getByRole("button", { name: "Start campaign" }).click();
    const statusA = page.getByRole("dialog", { name: "Campaign", exact: true });
    await expect(
      statusA.getByText("Posting live", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Device B's open dialog leaves setup for the live status surface by
    // itself — no reload, no reopen.
    const statusB = pageB.getByRole("dialog", {
      name: "Campaign",
      exact: true,
    });
    await expect(
      statusB.getByText("Posting live", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(statusB.getByText(/expires in/)).toBeVisible();
    await expect(
      pageB.getByRole("dialog", { name: "Set up a campaign" }),
    ).toBeHidden();

    // ── …and the kill switch converges the other way ─────────────────────
    await statusA.getByRole("button", { name: "■ Stop everything" }).click();
    await expect(
      statusB.getByText("Campaign stopped — posting has stopped"),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      statusB.getByRole("button", { name: "↻ Renew for 1 hour" }),
    ).toBeVisible();
  } finally {
    await contextB.close();
  }
});
