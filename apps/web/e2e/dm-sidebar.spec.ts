// The #170 verification E2E: the DM mini-profile sidebar. Opening a DM shows
// the partner's identity in the right column; the private note autosaves and
// survives a reload (it rides the profile response, like the viewer's note);
// the collapse toggle persists as a single global preference across reloads.
// Owns thistle@example.test (Thistle Vane; Bramble Fen is the raw-SimClient
// "other side") — spec files run in parallel, so specs never share characters.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

const NOTE_TEXT = "Met in the greenhouse. Owes me a trellis.";

test("DM sidebar: renders the partner, note autosaves + persists, collapse persists", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "thistle@example.test", "Thistle Vane");

  // Bramble Fen (the other side) opens the conversation with an inbound PM —
  // no shared channel needed. The DM row appears in the sidebar.
  const bramble = await SimClient.connect(
    "thistle@example.test",
    "hunter2",
    "Bramble Fen",
  );
  try {
    bramble.send("PRI", {
      recipient: "Thistle Vane",
      message: "Fresh cuttings for you.",
    });

    const nav = page.getByRole("navigation");
    await nav.getByRole("link", { name: /Bramble Fen/ }).click();
    await expect(page).toHaveURL(/\/dm\/Bramble%20Fen$/);

    // ── The sidebar renders the partner (open by default on a wide window) ─
    const sidebar = page.getByRole("complementary", {
      name: "Profile: Bramble Fen",
    });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText("Bramble Fen")).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Open full profile" }),
    ).toBeVisible();
    // The F-List page link is a profile link only (no notify/mention).
    await expect(
      sidebar.getByRole("link", { name: /F-List page/ }),
    ).toHaveAttribute("href", /\/c\/Bramble%20Fen$/);

    // ── Private note: autosave confirms with ✓ Saved ──────────────────────
    await sidebar.getByRole("button", { name: "+ Add private note" }).click();
    await sidebar
      .getByPlaceholder("Anything you want to remember about Bramble Fen…")
      .fill(NOTE_TEXT);
    await expect(sidebar.getByText("✓ Saved")).toBeVisible({ timeout: 10_000 });

    // ── Collapse: the header ◨ toggle hides the panel ─────────────────────
    await page.getByRole("button", { name: "Toggle profile panel" }).click();
    await expect(sidebar).not.toBeVisible();

    // ── Reload: the collapse preference persisted (still hidden) ──────────
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Bramble Fen" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("complementary", { name: "Profile: Bramble Fen" }),
    ).not.toBeVisible();

    // ── Reopen the panel: the note persisted (rides the profile response) ─
    await page.getByRole("button", { name: "Toggle profile panel" }).click();
    const reopened = page.getByRole("complementary", {
      name: "Profile: Bramble Fen",
    });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText(NOTE_TEXT)).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    bramble.close();
  }
});
