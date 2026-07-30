// The #316 "Invite to →" E2E: Briar Vale meets Nettle Fen in a public room,
// then invites her into the private Invite Harbor Briar owns. The character
// context menu offers an "Invite to →" submenu listing that room by TITLE
// (never its ADH- key); clicking it fires one CIU, the sim delivers the
// invitation to Nettle, and the browser confirms in plain language. Owns
// briar@example.test (Briar Vale; Nettle Fen is the raw-SimClient invitee)
// and the Invite Harbor room — parallel specs never share characters/channels.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

const HARBOR = "ADH-316inviteharbor00aa11bb";
const PUBLIC = "Gardening";

test('character menu "Invite to →" sends CIU for an eligible private room', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "briar@example.test", "Briar Vale");

  // Nettle waits in the public room where Briar will find her.
  const nettle = await SimClient.connect(
    "nettle@example.test",
    "hunter2",
    "Nettle Fen",
  );
  nettle.send("JCH", { channel: PUBLIC });
  await nettle.waitFor(
    "JCH",
    (p: { character: { identity: string } }) =>
      p.character.identity === "Nettle Fen",
  );

  // Briar joins the same public room, then her own hidden private room.
  await page.getByRole("button", { name: "Browse channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse channels" });
  await dialog.getByLabel("Join a hidden channel by name").fill(PUBLIC);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: PUBLIC })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "Browse channels" }).click();
  await dialog.getByLabel("Join a hidden channel by name").fill(HARBOR);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invite Harbor" }),
  ).toBeVisible({ timeout: 15_000 });

  // Back in the public room, right-click Nettle and open the submenu.
  await page.getByRole("link", { name: PUBLIC }).click();
  const members = page.getByRole("complementary", { name: "Members" });
  await expect(members.getByText("Nettle Fen")).toBeVisible();
  await members.getByText("Nettle Fen").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Nettle Fen menu" });
  await expect(menu).toBeVisible();

  await menu.getByRole("menuitem", { name: /^Invite to/ }).click();
  const submenu = page.getByRole("menu", {
    name: "Invite Nettle Fen to a channel",
  });
  // The room is shown by title, never by its opaque ADH- key (#311).
  await expect(
    submenu.getByRole("menuitem", { name: "Invite Harbor" }),
  ).toBeVisible();
  await expect(submenu.getByText(HARBOR)).not.toBeVisible();

  // Arm the listener before the click so the CIU can't race ahead of it.
  const inviteReceived = nettle.waitFor(
    "CIU",
    (p: { sender: string; name: string }) =>
      p.sender === "Briar Vale" && p.name === HARBOR,
  );
  await submenu.getByRole("menuitem", { name: "Invite Harbor" }).click();

  // The sim receives the CIU and delivers the invitation to Nettle...
  const invite = (await inviteReceived) as { title: string };
  expect(invite.title).toBe("Invite Harbor");

  // ...and the server's SYS surfaces as a plain-language confirmation.
  await expect(
    page.getByText(
      "Your invitation to Invite Harbor has been sent to Nettle Fen.",
    ),
  ).toBeVisible({ timeout: 15_000 });

  nettle.close();
});
