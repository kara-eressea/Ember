// The M6 op-tooling E2E: non-ops never see admin affordances; a live COA
// promotion unlocks them; a menu kick updates the member list and renders
// the SystemLine; slash moderation (/ban, /banlist) round-trips. Owns
// rue@example.test (Rue Alder; Alder Fen and Sorrel Vane are the
// raw-SimClient "other sides") and the hidden Potting Shed room — spec
// files run in parallel, so specs never share characters or channels.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

const SHED = "ADH-55ee66ff77aa88bb99cc";

test("op tooling: role-gated admin menu, kick with SystemLine, slash ban + banlist", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "rue@example.test", "Rue Alder");

  // Alder (owner) and Sorrel (moderation target) sit in the Potting Shed.
  const alder = await SimClient.connect(
    "rue@example.test",
    "hunter2",
    "Alder Fen",
  );
  alder.send("JCH", { channel: SHED });
  await alder.waitFor(
    "JCH",
    (p: { character: { identity: string } }) =>
      p.character.identity === "Alder Fen",
  );
  const sorrel = await SimClient.connect(
    "rue@example.test",
    "hunter2",
    "Sorrel Vane",
  );
  sorrel.send("JCH", { channel: SHED });
  await sorrel.waitFor(
    "JCH",
    (p: { character: { identity: string } }) =>
      p.character.identity === "Sorrel Vane",
  );

  // Rue joins by exact id through the browser footer (the room is hidden).
  await page.getByRole("button", { name: "Browse channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse channels" });
  await dialog.getByLabel("Join a hidden channel by name").fill(SHED);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Potting Shed" }),
  ).toBeVisible();

  // Non-op viewer: no ⚙ room chip, and the member menu has no admin items.
  const members = page.getByRole("complementary", { name: "Members" });
  await expect(members.getByText("Sorrel Vane")).toBeVisible();
  await expect(page.getByRole("button", { name: "⚙ room" })).not.toBeVisible();
  await members.getByText("Sorrel Vane").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Sorrel Vane menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByText("admin")).not.toBeVisible();
  await expect(menu.getByText("Kick")).not.toBeVisible();

  // Alert Staff (M7): the report form sends an SFC and the server's SYS
  // acknowledgment surfaces as a notice.
  await menu.getByRole("menuitem", { name: "Report to staff…" }).click();
  await menu
    .getByLabel("Report Sorrel Vane to staff")
    .fill("Being a test fixture.");
  await menu.getByRole("button", { name: "Send report" }).click();
  await expect(
    page.getByText("The moderators have been alerted.").first(),
  ).toBeVisible({ timeout: 15_000 });

  // The owner promotes Rue live (COA → channel.info): the admin
  // affordances appear without a reload.
  alder.send("COA", { channel: SHED, character: "Rue Alder" });
  await expect(page.getByRole("button", { name: "⚙ room" })).toBeVisible({
    timeout: 15_000,
  });

  // Room settings window: a Preferences-style modal with labeled groups and
  // segmented controls, not a wall of identical buttons (#312/#314). The ADH
  // room shows the invite + visibility groups; every room shows message mode
  // and description; the banlist is its own pane (see below).
  await page.getByRole("button", { name: "⚙ room" }).click();
  const roomDialog = page.getByRole("dialog", {
    name: "Room settings — Potting Shed",
  });
  await expect(
    roomDialog.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    roomDialog.getByRole("button", { name: "Banned characters", exact: true }),
  ).toBeVisible();
  await expect(roomDialog.getByText("Invite someone")).toBeVisible();
  await expect(
    roomDialog.getByRole("radiogroup", { name: "Who can join" }),
  ).toBeVisible();
  const messages = roomDialog.getByRole("radiogroup", {
    name: "Allowed messages",
  });
  await expect(messages).toBeVisible();
  // Plain-language segments instead of bare "chat/ads/both", each an
  // aria-checked radio that reflects the live mode.
  for (const name of ["Chat", "Ads", "Both"]) {
    await expect(messages.getByRole("radio", { name })).toHaveAttribute(
      "aria-checked",
      /true|false/,
    );
  }
  await expect(roomDialog.getByLabel("Channel description")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(roomDialog).not.toBeVisible();

  // Menu kick: Sorrel leaves the member list and the SystemLine lands.
  await members.getByText("Sorrel Vane").click({ button: "right" });
  await expect(menu.getByText("Kick")).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Kick/ }).click();
  await expect(members.getByText("Sorrel Vane")).not.toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("Sorrel Vane was kicked from the channel by Rue Alder."),
  ).toBeVisible();

  // Slash moderation: ban the (absent) character, then read the banlist —
  // both arrive as persisted SystemLines.
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("/ban Sorrel Vane");
  await composer.press("Enter");
  await expect(
    page.getByText("Sorrel Vane was banned from the channel by Rue Alder."),
  ).toBeVisible({ timeout: 15_000 });
  await composer.fill("/banlist");
  await composer.press("Enter");
  await expect(
    page.getByText("Channel bans for Potting Shed: Sorrel Vane."),
  ).toBeVisible({ timeout: 15_000 });

  // Banned-characters pane (#314 follow-up): the banlist is now a proper list
  // with a per-row unban, reusing the same CBL/CUB commands. Opening the pane
  // requests the list; the freshly-banned Sorrel appears; "Lift ban" unbans.
  await page.getByRole("button", { name: "⚙ room" }).click();
  await roomDialog
    .getByRole("button", { name: "Banned characters", exact: true })
    .click();
  await expect(
    roomDialog.getByRole("button", { name: "Lift ban on Sorrel Vane" }),
  ).toBeVisible({ timeout: 15_000 });
  await roomDialog
    .getByRole("button", { name: "Lift ban on Sorrel Vane" })
    .click();
  await expect(
    roomDialog.getByText("No one is banned from this room."),
  ).toBeVisible({
    timeout: 15_000,
  });

  alder.close();
  sorrel.close();
});
