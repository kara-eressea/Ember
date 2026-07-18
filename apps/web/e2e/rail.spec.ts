// The M3 verification E2E (milestone-3.md): two identities on one account,
// switched via the IdentityRail — the entire session context swaps, a
// background identity accumulates a rail badge while another is active, and
// the @me alias lands on the last-active identity. Owns rowan@example.test
// (Rowan Redleaf + Petal Thorn) and the Gardening channel: spec files run in
// parallel, a character can hold only one sim connection, and chat.spec
// counts Frontpage members — so specs share neither characters nor counted
// channels.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

test("identity rail: full context swap, background badges, @me alias", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // ── Rowan Redleaf: register → connect → join Gardening ────────────────
  await provisionAndConnect(page, "rowan@example.test", "Rowan Redleaf");
  await page.getByLabel("Join a channel").fill("Gardening");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Gardening" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/app\/Rowan%20Redleaf\/c\/Gardening$/);

  // ── Add + connect the second identity from the picker ─────────────────
  await page.getByRole("link", { name: "Add or manage identities" }).click();
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByRole("listitem").filter({ hasText: "Petal Thorn" }).click();
  // "Connect" would substring-match rows; the add flow's button is exact.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Petal Thorn · online")).toBeVisible({
    timeout: 15_000,
  });

  // Both identities on the rail; Petal (routed) is the active one.
  const rail = page.getByRole("navigation", { name: "Identities" });
  await expect(rail.getByTestId("rail-item")).toHaveCount(2);
  const rowanItem = rail.getByRole("link", { name: "Rowan Redleaf" });
  const petalItem = rail.getByRole("link", { name: "Petal Thorn" });

  // ── Petal joins a different channel — the two contexts diverge ────────
  await page.getByLabel("Join a channel").fill("Development");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Development" })).toBeVisible({
    timeout: 10_000,
  });

  // ── Rail switch: the ENTIRE context swaps, back at Rowan's last spot ──
  await rowanItem.click();
  await expect(page).toHaveURL(/\/app\/Rowan%20Redleaf\/c\/Gardening$/);
  await expect(page.getByText("Rowan Redleaf · online")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gardening" })).toBeVisible();
  // Rowan never joined Development: it is not in this sidebar.
  const nav = page.getByRole("navigation").last(); // the sidebar, not the rail
  await expect(nav.getByRole("link", { name: /Development/ })).toHaveCount(0);

  // ── Background badge: a PM to Petal while Rowan is active ─────────────
  const bramble = await SimClient.connect(
    "thorn@example.test",
    "hunter2",
    "Bramble Thorn",
  );
  try {
    bramble.send("PRI", { recipient: "Petal Thorn", message: "psst, petal" });
    await expect(petalItem.getByTestId("rail-badge")).toHaveText("1", {
      timeout: 10_000,
    });
    // The active identity never wears a badge.
    await expect(rowanItem.getByTestId("rail-badge")).toHaveCount(0);

    // ── Switch to Petal (her last conversation), read the DM ────────────
    await petalItem.click();
    await expect(page).toHaveURL(/\/app\/Petal%20Thorn\/c\/Development$/);
    await expect(page.getByText("Petal Thorn · online")).toBeVisible();
    await nav.getByRole("link", { name: /Bramble Thorn/ }).click();
    await expect(
      page.getByTestId("message-log").getByText("psst, petal"),
    ).toBeVisible();

    // Reading cleared the unread: Petal stays badge-free in the background.
    await rowanItem.click();
    await expect(page.getByText("Rowan Redleaf · online")).toBeVisible();
    await expect(petalItem.getByTestId("rail-badge")).toHaveCount(0);

    // ── @me lands on the last-active identity ───────────────────────────
    await page.goto("/app/@me");
    await expect(page).toHaveURL(/\/app\/Rowan%20Redleaf/);

    // ── Rail menu: set status ────────────────────────────────────────────
    await rowanItem.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Rowan Redleaf menu" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "away", exact: true }).click();
    // The MeBar status line converges via the presence fan-out.
    await expect(
      page.getByRole("button", { name: "Set status" }),
    ).toContainText("away", { timeout: 10_000 });

    // ── Rail menu: move down persists the order server-side ─────────────
    await rowanItem.click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Move down" }).click();
    await expect(rail.getByTestId("rail-item").first()).toHaveAccessibleName(
      /Petal Thorn/,
    );
    await page.reload();
    await expect(page.getByText("Rowan Redleaf · online")).toBeVisible({
      timeout: 15_000,
    });
    await expect(rail.getByTestId("rail-item").first()).toHaveAccessibleName(
      /Petal Thorn/,
    );

    // ── Quick-switcher (M9 step 6): Ctrl+K → fuzzy jump ─────────────────
    await page.keyboard.press("Control+k");
    const switcher = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(switcher).toBeVisible();
    await switcher.getByRole("combobox").fill("gard");
    await expect(
      switcher.getByRole("option", { name: /Gardening/ }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(switcher).not.toBeVisible();
    await expect(page).toHaveURL(/\/c\/Gardening$/);
    // Identities rank too — Escape closes without navigating.
    await page.keyboard.press("Control+k");
    await switcher.getByRole("combobox").fill("petal");
    await expect(
      switcher.getByRole("option", { name: /Petal Thorn/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(switcher).not.toBeVisible();
  } finally {
    bramble.close();
  }
});
