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
  solidPng,
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

test("profile viewer: fullscreen centers content, lightbox zoom fills the viewport", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await interceptAvatars(page);
  // Real, measurable images for the lightbox: a large portrait (zoom binds on
  // height and fills the viewport) and a tiny one (never upscaled). Registered
  // after interceptAvatars so these specific routes take precedence.
  await page
    .context()
    .route("https://static.f-list.net/images/charimage/90001.png", (route) =>
      route.fulfill({ contentType: "image/png", body: solidPng(1200, 1600) }),
    );
  await page
    .context()
    .route("https://static.f-list.net/images/charimage/90002.png", (route) =>
      route.fulfill({ contentType: "image/png", body: solidPng(300, 200) }),
    );

  await provisionAndConnect(page, "juniper@example.test", "Juniper Wren");
  await joinChannel(page, ROOM_ID, "Reading Nook");

  const members = page.getByRole("complementary", { name: "Members" });
  await members.getByText("Tally Marsh").click({ button: "right" });
  await page
    .getByRole("menu", { name: "Tally Marsh menu" })
    .getByRole("menuitem", { name: "View profile" })
    .click();
  const viewer = page.getByRole("dialog", { name: "Profile: Tally Marsh" });
  await expect(viewer).toBeVisible();

  // ── #238: the content column centers in the wide fullscreen window ────
  await viewer.getByRole("button", { name: "Fullscreen" }).click();
  const rail = viewer.getByRole("navigation", {
    name: "Recently viewed profiles",
  });
  const content = viewer.getByTestId("profile-content");
  const dialogBox = (await viewer.boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  const leftSpace = contentBox.x - (railBox.x + railBox.width);
  const rightSpace =
    dialogBox.x + dialogBox.width - (contentBox.x + contentBox.width);
  // Column is capped (not stretched across the whole main region) and sits
  // with roughly equal gutters either side — i.e. centered, not left-aligned.
  expect(contentBox.width).toBeLessThanOrEqual(800);
  expect(leftSpace).toBeGreaterThan(60);
  expect(rightSpace).toBeGreaterThan(60);
  expect(Math.abs(leftSpace - rightSpace)).toBeLessThan(24);
  await viewer.getByRole("button", { name: "Exit fullscreen" }).click();

  // ── #236: zoom reaches true full-screen size, capped at natural ───────
  await viewer.getByRole("tab", { name: "Images" }).click();
  await viewer.getByRole("button", { name: "Image 1 of 2" }).click();
  const lightbox = page.getByRole("dialog", { name: "Image 1 of 2" });
  await expect(lightbox).toBeVisible();
  const bigImg = lightbox.locator("img");
  await expect(bigImg).toHaveJSProperty("complete", true);
  const fitBox = (await bigImg.boundingBox())!;
  // Fit view stops short of the viewport height.
  expect(fitBox.height).toBeLessThan(700);

  await bigImg.click();
  await expect(bigImg).toHaveAttribute("aria-label", "Zoom out");
  const zoomBox = (await bigImg.boundingBox())!;
  // Zoomed: the 1200×1600 source scales up to fill the viewport height
  // (900 − 56px nav strip ≈ 844), well past the fit size.
  expect(zoomBox.height).toBeGreaterThan(fitBox.height);
  expect(zoomBox.height).toBeGreaterThan(800);
  expect(zoomBox.height).toBeLessThanOrEqual(846);

  // ── #236: a small image is never upscaled past its natural size ───────
  await lightbox.getByRole("button", { name: "Next image" }).click();
  const smallLightbox = page.getByRole("dialog", { name: "Image 2 of 2" });
  const smallImg = smallLightbox.locator("img");
  await expect(smallImg).toHaveJSProperty("complete", true);
  await smallImg.click();
  await expect(smallImg).toHaveAttribute("aria-label", "Zoom out");
  const smallZoom = (await smallImg.boundingBox())!;
  // Natural size is 300×200 — zoom must not blow it up.
  expect(smallZoom.width).toBeLessThanOrEqual(302);
  expect(smallZoom.height).toBeLessThanOrEqual(202);
});
