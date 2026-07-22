// The #346 identity-rail-toggle E2E: clicking your own avatar (the MeBar,
// bottom-left) hides the identity rail, the choice survives a reload (per-
// device localStorage, like the #303 resizable columns), and connecting a
// second identity forces the hidden rail back into view so a newly-connected
// character is never lost. Owns tamarisk@example.test (Tamarisk Ash + Marsh
// Willow) — spec files run in parallel and a character holds one sim
// connection, so specs never share one.

import { expect, test } from "@playwright/test";
import { interceptAvatars, provisionAndConnect } from "./helpers.js";

test("identity rail: avatar toggle hides it, the choice survives a reload, a second identity un-hides it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "tamarisk@example.test", "Tamarisk Ash");

  const rail = page.getByRole("navigation", { name: "Identities" });
  const hide = page.getByRole("button", { name: "Hide identity rail" });
  const show = page.getByRole("button", { name: "Show identity rail" });

  // With a single identity the rail is visible and the avatar offers to hide.
  await expect(rail).toBeVisible();
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute("aria-pressed", "false");

  // ── Click the avatar → the rail collapses out of the layout ───────────
  await hide.click();
  await expect(rail).toBeHidden();
  await expect(show).toBeVisible();
  await expect(show).toHaveAttribute("aria-pressed", "true");

  // ── Reload → the per-device choice is remembered, no flash-then-hide ───
  await page.reload();
  await expect(page.getByText("Tamarisk Ash · online")).toBeVisible({
    timeout: 15_000,
  });
  await expect(rail).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Show identity rail" }),
  ).toBeVisible();

  // ── Connect a second identity → the hidden rail is forced back visible.
  //    The rail's own "+" is hidden with it, so reach the manager directly.
  await page.goto("/identities");
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByRole("listitem").filter({ hasText: "Marsh Willow" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Marsh Willow · online")).toBeVisible({
    timeout: 15_000,
  });

  await expect(rail).toBeVisible();
  await expect(rail.getByTestId("rail-item")).toHaveCount(2);
  // The label tracks the effective visibility: forced visible, it reads
  // "Hide" again — while the stored preference stays hidden underneath, ready
  // to take effect the moment the second identity drops away.
  await expect(
    page.getByRole("button", { name: "Hide identity rail" }),
  ).toBeVisible();
});
