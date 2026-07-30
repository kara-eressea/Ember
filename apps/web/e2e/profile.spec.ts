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
  await expect(viewer.getByText("✓ Saved")).toBeVisible({ timeout: 10_000 });
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

  // ── #238 / #331: the reading column centers in the wide fullscreen window,
  // the scroll container spans the full width so its scrollbar sits at the
  // viewport edge, and the column is wider than the windowed cap ────────────
  const rail = viewer.getByRole("navigation", {
    name: "Recently viewed profiles",
  });
  const content = viewer.getByTestId("profile-content");
  const column = viewer.getByTestId("profile-column");

  // Windowed column width, for the "fullscreen is wider" comparison below.
  const windowedColumnBox = (await column.boundingBox())!;

  await viewer.getByRole("button", { name: "Fullscreen" }).click();
  const dialogBox = (await viewer.boundingBox())!;
  const railBox = (await rail.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  const columnBox = (await column.boundingBox())!;

  // #331 (2): the scroll container spans the whole main region — its left edge
  // meets the rail and its right edge lands at the dialog's right edge (within
  // the 1px window border), so the scrollbar anchors to the screen edge rather
  // than riding the centered column mid-screen.
  expect(contentBox.x).toBeCloseTo(railBox.x + railBox.width, -1);
  expect(contentBox.x + contentBox.width).toBeCloseTo(
    dialogBox.x + dialogBox.width,
    -1,
  );

  // The reading column is capped (not stretched across the whole main region)
  // and centered — roughly equal gutters either side of the scroll container.
  const leftSpace = columnBox.x - contentBox.x;
  const rightSpace =
    contentBox.x + contentBox.width - (columnBox.x + columnBox.width);
  expect(leftSpace).toBeGreaterThan(60);
  expect(rightSpace).toBeGreaterThan(60);
  expect(Math.abs(leftSpace - rightSpace)).toBeLessThan(24);

  // #331 (1): fullscreen uses meaningfully more width than the windowed cap.
  expect(columnBox.width).toBeGreaterThan(windowedColumnBox.width + 100);

  // #339: the custom profile text (the readable-width BBCode block) is itself
  // capped narrower than the wide column, and centers within it — equal gutters
  // either side — rather than stranding on the left.
  const textBox = (await viewer.getByTestId("profile-text").boundingBox())!;
  expect(textBox.width).toBeLessThan(columnBox.width - 100);
  const textLeft = textBox.x - columnBox.x;
  const textRight = columnBox.x + columnBox.width - (textBox.x + textBox.width);
  expect(textLeft).toBeGreaterThan(60);
  expect(textRight).toBeGreaterThan(60);
  expect(Math.abs(textLeft - textRight)).toBeLessThan(24);
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

  // ── #276 item 2 + #236: zoom carries across images within the lightbox,
  // and a small image is still never upscaled past its natural size ───────
  await lightbox.getByRole("button", { name: "Next image" }).click();
  const smallLightbox = page.getByRole("dialog", { name: "Image 2 of 2" });
  const smallImg = smallLightbox.locator("img");
  await expect(smallImg).toHaveJSProperty("complete", true);
  // Paging no longer resets zoom: the next image opens already zoomed.
  await expect(smallImg).toHaveAttribute("aria-label", "Zoom out");
  const smallZoom = (await smallImg.boundingBox())!;
  // Natural size is 300×200 — carried zoom must not blow it up.
  expect(smallZoom.width).toBeLessThanOrEqual(302);
  expect(smallZoom.height).toBeLessThanOrEqual(202);
});

// #283: the Insights private-note editor must survive the insights data load
// resolving under it (the fetch lands ~1s after the tab opens), and the note
// now sits below the insights content — not above it.
test("insights note: survives the insights load and sits below the content", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // Hold the insights fetch open so its resolution — and the render branch it
  // flips (shimmer → loaded panel) — lands after the editor is already open,
  // the exact timing that used to remount PrivateNote and slam it shut once the
  // note was moved below the swapping content.
  await page.route("**/profile/**/insights", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

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

  await viewer.getByRole("tab", { name: "Insights" }).click();
  // Open the editor while insights is still loading (shimmer showing).
  await viewer.getByRole("button", { name: "+ Add private note" }).click();
  const editor = viewer.getByPlaceholder(
    "Anything you want to remember about Tally Marsh…",
  );
  await expect(editor).toBeVisible();

  // Let the held insights fetch resolve and the panel render underneath.
  await expect(viewer.getByText(/YOU ×/)).toBeVisible({ timeout: 10_000 });

  // The editor must still be here and writable — typing after the load lands.
  const survived = "written after the insights panel rendered";
  await editor.fill(survived);
  await expect(editor).toHaveValue(survived);
  await expect(viewer.getByText("✓ Saved")).toBeVisible({ timeout: 10_000 });

  // …and the note lives below the insights content now, not above it.
  const noteTop = (await editor.boundingBox())!.y;
  const insightsTop = (await viewer.getByText(/YOU ×/).boundingBox())!.y;
  expect(noteTop).toBeGreaterThan(insightsTop);
});

// #276 item 1: the full-screen window choice is a device-level pref that
// survives a reload and applies to the next profile opened.
test("profile viewer: full-screen window size persists across reopen", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await interceptAvatars(page);

  await provisionAndConnect(page, "juniper@example.test", "Juniper Wren");
  await joinChannel(page, ROOM_ID, "Reading Nook");

  async function openTallyProfile() {
    const members = page.getByRole("complementary", { name: "Members" });
    await members.getByText("Tally Marsh").click({ button: "right" });
    await page
      .getByRole("menu", { name: "Tally Marsh menu" })
      .getByRole("menuitem", { name: "View profile" })
      .click();
    const viewer = page.getByRole("dialog", { name: "Profile: Tally Marsh" });
    await expect(viewer).toBeVisible();
    return viewer;
  }

  // Open, go full-screen, then close.
  let viewer = await openTallyProfile();
  await viewer.getByRole("button", { name: "Fullscreen" }).click();
  await expect(
    viewer.getByRole("button", { name: "Exit fullscreen" }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: "Close profile" }).click();
  await expect(viewer).toBeHidden();

  // Reopening the same session's viewer starts full-screen (in-memory pref).
  viewer = await openTallyProfile();
  await expect(
    viewer.getByRole("button", { name: "Exit fullscreen" }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: "Close profile" }).click();

  // The choice is persisted to localStorage, so it also survives a full reload.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reading Nook" })).toBeVisible(
    { timeout: 15_000 },
  );
  viewer = await openTallyProfile();
  await expect(
    viewer.getByRole("button", { name: "Exit fullscreen" }),
  ).toBeVisible();
});
