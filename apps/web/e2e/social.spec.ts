// The M6 social E2E: the sidebar's Friends/Bookmarks sections load from the
// social endpoint (seeded fixtures), an incoming friend request is an
// actionable row, and the member menu's bookmark item is relationship-aware
// end to end. Owns fern@example.test (Fern Glade) and the hidden Fernery
// room — spec files run in parallel, so specs never share characters or
// channels.

import { expect, test } from "@playwright/test";
import { interceptAvatars, registerAndConnect } from "./helpers.js";

const FERNERY = "ADH-33cc44dd55ee66ff77aa";

test("social: friends/bookmarks sections, request accept, bookmark round-trip", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await registerAndConnect(page, "fern@example.test", "Fern Glade");

  // The seeded lists render: a friend with a presence dot, a bookmark, and
  // the incoming request as an actionable row.
  const sidebar = page.getByRole("navigation");
  await expect(sidebar.getByText("Nyx Firemane")).toBeVisible({
    timeout: 15_000,
  });
  await expect(sidebar.getByText("Old Greywhisker")).toBeVisible();
  await expect(
    sidebar.getByText("Tally Marsh sent a friend request", { exact: false }),
  ).toBeVisible();

  // Accept: Tally Marsh becomes a friend and the request row is consumed.
  await sidebar
    .getByRole("button", { name: "Accept friend request from Tally Marsh" })
    .click();
  await expect(
    sidebar.getByRole("button", { name: "Tally Marsh", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    sidebar.getByText("sent a friend request", { exact: false }),
  ).not.toBeVisible();

  // A friend row opens the DM.
  await sidebar
    .getByRole("button", { name: "Nyx Firemane", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dm\/Nyx%20Firemane/);

  // Member menu: the bookmark item is relationship-aware. Old Greywhisker
  // is seeded as a bookmark → "Remove bookmark"; after removing, the
  // sidebar section empties and the menu flips to "Add bookmark".
  await page.getByRole("button", { name: "Browse channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse channels" });
  await dialog.getByLabel("Join a hidden channel by name").fill(FERNERY);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fernery" })).toBeVisible();

  const members = page.getByRole("complementary", { name: "Members" });
  await members.getByText("Old Greywhisker").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Old Greywhisker menu" });
  await menu.getByRole("menuitem", { name: "Remove bookmark" }).click();
  await expect(sidebar.getByText("No bookmarks yet.")).toBeVisible({
    timeout: 15_000,
  });
  await members.getByText("Old Greywhisker").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Add bookmark" }).click();
  await expect(
    sidebar.getByRole("button", { name: "Old Greywhisker", exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // Friend items are relationship-aware too: an existing friend offers
  // removal, a stranger offers "Add friend".
  await members.getByText("Tally Marsh").click({ button: "right" });
  await expect(
    page
      .getByRole("menu", { name: "Tally Marsh menu" })
      .getByRole("menuitem", { name: "Remove friend" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});
