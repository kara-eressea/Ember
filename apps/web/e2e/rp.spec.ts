// The M6 RP-messages E2E: roleplay ads (LRP) render distinctly and obey the
// ads-visibility preference (global default + per-channel override), /roll
// and /bottle produce roll lines (RLL), and an op's RMO re-gates the
// composer live. Owns ivy@example.test (Ivy Bramblewood; Moss Tinker is the
// raw-SimClient "other side") and the hidden Greenhouse room — spec files
// run in parallel, so specs never share characters or channels.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

const GREENHOUSE = "ADH-77aa88bb99cc00dd11ee";

test("RP messages: ads with visibility prefs, dice and bottle, RMO gating", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "ivy@example.test", "Ivy Bramblewood");

  // Moss (op) sits in the Greenhouse as the other member.
  const moss = await SimClient.connect(
    "ivy@example.test",
    "hunter2",
    "Moss Tinker",
  );
  moss.send("JCH", { channel: GREENHOUSE });
  await moss.waitFor(
    "JCH",
    (p: { character: { identity: string } }) =>
      p.character.identity === "Moss Tinker",
  );

  // Ivy joins by exact id through the browser footer (the room is hidden).
  await page.getByRole("button", { name: "Browse channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse channels" });
  await dialog.getByLabel("Join a hidden channel by name").fill(GREENHOUSE);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Greenhouse" })).toBeVisible();

  // Mode "both": the composer offers the Ad toggle; sending as an ad
  // renders the tagged ad row (own ads always show).
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const adToggle = page.getByRole("button", { name: "♥ Ad", exact: true });
  await adToggle.click();
  await composer.fill("Fresh cuttings, seeking green thumbs.");
  await composer.press("Enter");
  const ownAd = page.locator("[data-ad]").filter({ hasText: "Fresh cuttings" });
  await expect(ownAd).toBeVisible({ timeout: 15_000 });
  await expect(ownAd.getByText("AD")).toBeVisible();
  await adToggle.click(); // back to plain messages

  // /roll → a dice roll line; /bottle can only land on Moss.
  await composer.fill("/roll 2d6");
  await composer.press("Enter");
  await expect(
    page.getByTestId("roll-line").filter({ hasText: "rolls 2d6" }),
  ).toBeVisible({ timeout: 15_000 });
  await composer.fill("/bottle");
  await composer.press("Enter");
  await expect(
    page
      .getByTestId("roll-line")
      .filter({ hasText: "spins the bottle: Moss Tinker" }),
  ).toBeVisible({ timeout: 15_000 });

  // Unknown slash commands never reach the wire.
  await composer.fill("/frolic");
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Unknown command");

  // Moss's inbound ad renders as an ad row.
  moss.send("LRP", { channel: GREENHOUSE, message: "Trellis, gently used." });
  const mossAd = page.locator("[data-ad]").filter({ hasText: "Trellis" });
  await expect(mossAd).toBeVisible({ timeout: 15_000 });

  // Global preference: hide ads everywhere (view default = Chat). Moss's
  // ad vanishes, Ivy's own stays (you always see what you posted).
  await page.getByRole("button", { name: "Preferences" }).click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await prefs.getByRole("switch", { name: "Hide ads everywhere" }).click();
  await page.keyboard.press("Escape");
  await expect(mossAd).not.toBeVisible();
  await expect(ownAd).toBeVisible();

  // Per-channel override: the channel row's context menu (#234) carries
  // the Show submenu; flipping it back to Both restores Moss's ad.
  const channelRow = page.getByRole("link", { name: /Greenhouse/ });
  await channelRow.click({ button: "right" });
  const channelMenu = page.getByRole("menu", { name: "Greenhouse menu" });
  await channelMenu.getByRole("menuitem", { name: "Show" }).click();
  const showMenu = page.getByRole("menu", { name: "Show chat, ads, or both" });
  await expect(
    showMenu.getByRole("menuitemradio", { name: "Chat" }),
  ).toHaveAttribute("aria-checked", "true");
  await showMenu.getByRole("menuitemradio", { name: "Both" }).click();
  await expect(mossAd).toBeVisible();

  // RMO: the op flips the room chat-only; the Ad toggle and the menu's
  // Show submenu leave the UI live (channel.info fan-out).
  moss.send("RMO", { channel: GREENHOUSE, mode: "chat" });
  await expect(adToggle).not.toBeVisible({ timeout: 15_000 });
  await channelRow.click({ button: "right" });
  await expect(channelMenu).toBeVisible();
  await expect(
    channelMenu.getByRole("menuitem", { name: "Show" }),
  ).not.toBeVisible();
  await page.keyboard.press("Escape");

  moss.close();
});
