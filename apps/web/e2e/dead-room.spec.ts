// The #327 dead-private-room E2E: a private room Cinder Ash holds is
// destroyed out from under her (F-Chat reaps empty ADH- rooms), leaving a
// stranded sidebar row that offers a "Join" that can only fail. This spec
// reproduces that ghost without a bouncer restart: Vault Keeper (a raw
// SimClient) creates an ADH- room, invites Cinder, kicks her (so her client
// keeps the row but is no longer live in it), then leaves — the sim reaps
// the now-empty room. Cinder's Join then fails and, crucially, she can still
// leave/close the dead row. Owns cinder@example.test / vault@example.test and
// the room Vault Keeper mints — parallel specs never share characters/rooms.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

test("a destroyed private room can still be left after its join fails", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "cinder@example.test", "Cinder Ash");

  // Vault Keeper mints a private room and captures its minted ADH- id.
  const keeper = await SimClient.connect(
    "vault@example.test",
    "hunter2",
    "Vault Keeper",
  );
  keeper.send("CCR", { channel: "Ember Vault" });
  const created = (await keeper.waitFor(
    "JCH",
    (p: { character: { identity: string }; channel: string }) =>
      p.character.identity === "Vault Keeper",
  )) as { channel: string };
  const room = created.channel;
  expect(room).toMatch(/^ADH-/);

  // Keeper invites Cinder; she accepts from the sidebar invite row and lands
  // in the room, live.
  keeper.send("CIU", { channel: room, character: "Cinder Ash" });
  await page.getByRole("button", { name: "Join Ember Vault" }).click();
  await expect(page.getByRole("heading", { name: "Ember Vault" })).toBeVisible({
    timeout: 15_000,
  });

  // Keeper kicks Cinder: her client keeps the row but she is no longer a live
  // member, so the composer flips to the rejoin affordance.
  keeper.send("CKU", { channel: room, character: "Cinder Ash" });
  await expect(page.getByRole("button", { name: `Join ${room}` })).toBeVisible({
    timeout: 15_000,
  });

  // Keeper leaves the now sole-occupied room and the sim reaps it — waiting on
  // Keeper's own LCH echo confirms the room is gone before we probe it.
  const keeperLeft = keeper.waitFor(
    "LCH",
    (p: { character: string }) => p.character === "Vault Keeper",
    15_000,
  );
  keeper.send("LCH", { channel: room });
  await keeperLeft;

  // The Join now targets a room that no longer exists. Instead of looping a
  // dead Join, the affordance settles into plain language.
  await page.getByRole("button", { name: `Join ${room}` }).click();
  await expect(page.getByText(/no longer exists/i)).toBeVisible({
    timeout: 15_000,
  });

  // And the whole point of the fix: the stranded row can be left/closed. Right
  // -click the sidebar row and choose Leave — the row disappears.
  await page.getByRole("link", { name: "Ember Vault" }).click({
    button: "right",
  });
  const menu = page.getByRole("menu", { name: "Ember Vault menu" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Leave channel" }).click();

  await expect(page.getByRole("link", { name: "Ember Vault" })).toHaveCount(0, {
    timeout: 15_000,
  });

  keeper.close();
});
