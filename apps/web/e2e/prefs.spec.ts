// The M5 preferences-window E2E (COMPONENTS.md §12): the MeBar gear opens
// the modal, the rail switches panes, Escape and the backdrop close it.
// Owns hazel@example.test (Hazel Fenwick) — spec files run in parallel and
// a character can hold only one sim connection, so specs never share one.
// Pane contents (accent switching, rules UI, …) get asserted as their M5
// steps land.

import { expect, test } from "@playwright/test";
import { interceptAvatars, registerAndConnect } from "./helpers.js";

test("preferences window: open from the gear, pane nav, close paths", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await registerAndConnect(page, "hazel@example.test", "Hazel Fenwick");

  // Gear → window. General is the landing pane.
  await page.getByRole("button", { name: "Preferences" }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(
    dialog.getByText("Account & profile live on the server website"),
  ).toBeVisible();

  // Rail nav switches the pane.
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Appearance" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Away & logs" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Away & logs" }),
  ).toBeVisible();

  // Escape closes.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // Reopen; the ✕ closes too.
  await page.getByRole("button", { name: "Preferences" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close preferences" }).click();
  await expect(dialog).not.toBeVisible();
});
