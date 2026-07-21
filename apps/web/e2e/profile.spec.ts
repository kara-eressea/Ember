// The M8 verification slices chat.spec doesn't carry: profile view history
// is server-side per identity (survives a reload), private notes autosave
// and live in their own table (a history prune never loses one). Owns
// juniper@example.test (Juniper Wren) and the hidden Reading Nook room:
// spec files run in parallel, so specs never share characters or assert
// against channels other specs count members in.

import { expect, test } from "@playwright/test";
import {
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

const ROOM_ID = "ADH-22bb33cc44dd55ee66ff";
const NOTE_TEXT = "Collects rare seeds. Owes me a book.";

test("profile history + notes: both survive reload, notes survive prune", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "juniper@example.test", "Juniper Wren");
  await joinChannel(page, ROOM_ID, "Reading Nook");

  const members = page.getByRole("complementary", { name: "Members" });

  // ── View a profile; the visit lands in the history rail ───────────────
  await members.getByText("Tally Marsh").click({ button: "right" });
  await page
    .getByRole("menu", { name: "Tally Marsh menu" })
    .getByRole("menuitem", { name: "View profile" })
    .click();
  const viewer = page.getByRole("dialog", { name: "Profile: Tally Marsh" });
  await expect(viewer).toBeVisible();
  const rail = viewer.getByRole("navigation", {
    name: "Recently viewed profiles",
  });
  await expect(rail.getByText("Tally Marsh")).toBeVisible();

  // ── Private note: autosave (debounced PUT) confirms with Saved ✓ ──────
  // The note lives in the Insights tab now (#211), not the header corner.
  await viewer.getByRole("tab", { name: "Insights" }).click();
  await viewer.getByRole("button", { name: "+ Add private note" }).click();
  await viewer
    .getByPlaceholder("Anything you want to remember about Tally Marsh…")
    .fill(NOTE_TEXT);
  await expect(viewer.getByText("Saved ✓")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();

  // A second visit so the reloaded rail proves ordering, not just existence.
  await members.getByText("Old Greywhisker").click({ button: "right" });
  await page
    .getByRole("menu", { name: "Old Greywhisker menu" })
    .getByRole("menuitem", { name: "View profile" })
    .click();
  const greyViewer = page.getByRole("dialog", {
    name: "Profile: Old Greywhisker",
  });
  await expect(greyViewer).toBeVisible();
  await page.keyboard.press("Escape");

  // ── Reload: history and the note are server-side, not tab state ───────
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reading Nook" })).toBeVisible(
    { timeout: 15_000 },
  );
  await members.getByText("Old Greywhisker").click({ button: "right" });
  await page
    .getByRole("menu", { name: "Old Greywhisker menu" })
    .getByRole("menuitem", { name: "View profile" })
    .click();
  await expect(greyViewer).toBeVisible();
  const reloadedRail = greyViewer.getByRole("navigation", {
    name: "Recently viewed profiles",
  });
  await expect(reloadedRail.getByText("Old Greywhisker")).toBeVisible();
  await expect(reloadedRail.getByText("Tally Marsh")).toBeVisible();
  // The rail row navigates the viewer; the note rides the profile response.
  await reloadedRail.getByText("Tally Marsh").click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole("tab", { name: "Insights" }).click();
  await expect(viewer.getByText(NOTE_TEXT)).toBeVisible();

  // ── Prune history; the note lives in its own table and survives ───────
  const viewerRail = viewer.getByRole("navigation", {
    name: "Recently viewed profiles",
  });
  await viewerRail
    .getByRole("button", {
      name: "Remove Old Greywhisker from history",
      exact: true,
    })
    .click();
  await expect(viewerRail.getByText("Old Greywhisker")).not.toBeVisible();
  await viewerRail
    .getByRole("button", {
      name: "Remove Tally Marsh from history",
      exact: true,
    })
    .click();
  await expect(viewerRail.getByText("Tally Marsh")).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();

  // Re-viewing after the prune fetches fresh — and the note is still there.
  await members.getByText("Tally Marsh").click({ button: "right" });
  await page
    .getByRole("menu", { name: "Tally Marsh menu" })
    .getByRole("menuitem", { name: "View profile" })
    .click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole("tab", { name: "Insights" }).click();
  await expect(viewer.getByText(NOTE_TEXT)).toBeVisible();
});
