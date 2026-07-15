// The M6 channel-browser E2E (COMPONENTS.md §11): the sidebar + opens the
// dialog, tabs list official channels and open rooms with counts, the filter
// narrows rows, Join flips to ✓ Joined and the channel appears in the
// sidebar, and the footer joins a hidden room by exact id (hidden rooms
// never appear in the lists). Owns laurel@example.test (Laurel Quince) —
// spec files run in parallel and a character can hold only one sim
// connection, so specs never share one.

import { expect, test } from "@playwright/test";
import { interceptAvatars, registerAndConnect } from "./helpers.js";

test("channel browser: browse, filter, join, hidden-by-name", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await registerAndConnect(page, "laurel@example.test", "Laurel Quince");

  // Sidebar + opens the dialog.
  await page.getByRole("button", { name: "Browse channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse channels" });
  await expect(dialog).toBeVisible();

  // Header shows honest staleness + total room count once the directory
  // loads (the sim world lists 5 official + 1 open room; the hidden Root
  // Cellar never counts).
  await expect(dialog.getByText(/updated just now/)).toBeVisible();
  await expect(dialog.getByText("6 rooms")).toBeVisible();

  // Official tab lists Orchard with a Join button; the open-rooms tab lists
  // Ember Lounge but never the hidden room.
  await expect(dialog.getByRole("tab", { name: /Official/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByText("Orchard")).toBeVisible();
  await dialog.getByRole("tab", { name: /Open rooms/ }).click();
  await expect(dialog.getByText("Ember Lounge")).toBeVisible();
  await expect(dialog.getByText("Root Cellar")).not.toBeVisible();
  await dialog.getByRole("tab", { name: /Official/ }).click();

  // Filter narrows by name.
  await dialog.getByLabel("Filter channels").fill("orch");
  await expect(dialog.getByText("Orchard")).toBeVisible();
  await expect(dialog.getByText("Frontpage")).not.toBeVisible();

  // Join → the button flips to ✓ Joined (store round-trip) and the channel
  // lands in the sidebar behind the dialog.
  await dialog.getByRole("button", { name: "Join Orchard" }).click();
  await expect(dialog.getByText("✓ Joined")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Orchard" })).toBeVisible();

  // Footer: join the hidden room by exact id — it navigates and closes.
  await dialog
    .getByLabel("Join a hidden channel by name")
    .fill("ADH-9f8e7d6c5b4a39281706");
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/ADH-9f8e7d6c5b4a39281706/);
  await expect(
    page.getByRole("heading", { name: "Root Cellar" }),
  ).toBeVisible();
});
