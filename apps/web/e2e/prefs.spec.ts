// The M5 preferences-window E2E (COMPONENTS.md §12): the MeBar gear opens
// the modal, the rail switches panes, Escape and the backdrop close it, and
// the Appearance pane's accent choice persists across a reload AND a second
// device (the milestone-5.md verification target — prefs live server-side).
// Owns hazel@example.test (Hazel Fenwick) — spec files run in parallel and
// a character can hold only one sim connection, so specs never share one.

import { expect, test, type Page } from "@playwright/test";
import { interceptAvatars, registerAndConnect } from "./helpers.js";

/** The applied accent, straight from the theme's CSS custom property. */
function appliedAccent(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--eb-accent")
      .trim(),
  );
}

const MOSS = "#88ac72";

test("preferences window: gear, pane nav, accent persists across reload + devices", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  const creds = await registerAndConnect(
    page,
    "hazel@example.test",
    "Hazel Fenwick",
  );

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

  // ── Appearance: pick Moss Green, watch the theme repaint live ─────────
  expect(await appliedAccent(page)).not.toBe(MOSS);
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await dialog.getByRole("radio", { name: "Moss Green" }).click();
  await expect.poll(() => appliedAccent(page), { timeout: 5000 }).toBe(MOSS);
  await page.keyboard.press("Escape");

  // Survives a reload (flash cache + server prefs agree).
  await page.reload();
  await expect(page.getByText("Hazel Fenwick · online")).toBeVisible({
    timeout: 15_000,
  });
  expect(await appliedAccent(page)).toBe(MOSS);

  // ── A second device logs in fresh and paints Moss from the server ─────
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    await interceptAvatars(pageB);
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(creds.email);
    await pageB.getByLabel("Password").fill(creds.password);
    await pageB.getByRole("button", { name: "Log in" }).click();
    await expect(pageB).toHaveURL(/\/identities$/);
    // The session is already live (device A connected it) → Open.
    await pageB.getByRole("button", { name: "Open", exact: true }).click();
    await expect(pageB).toHaveURL(/\/app\//);
    // The snapshot's prefs hydrate the theme — no local cache involved.
    await expect
      .poll(() => appliedAccent(pageB), { timeout: 10_000 })
      .toBe(MOSS);
  } finally {
    await contextB.close();
  }
});
