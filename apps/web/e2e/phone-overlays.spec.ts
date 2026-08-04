// The phone tier's right-hand panels (#375, MP1 package D) against real
// browser geometry: on a 390×844 viewport the member list and the DM profile
// are full-height overlays over the conversation, not grid columns — they
// start closed however the docked preferences are set, open from the ⋯ menu,
// close on Escape / the backdrop / their own ✕, and never leave the page
// scrolling sideways. Back on a desktop viewport the docked columns are
// exactly what they were.
//
// This runs in the ordinary Chromium project and merely resizes the viewport;
// a dedicated mobile project with device emulation is MP1 package G.
//
// Owns vaneoverlay@example.test (Vane Overlay), sheetwren@example.test
// (Sheet Wren) and the Overlay Room: spec files run in parallel and a
// character holds one sim connection, so specs share neither.

import { type Locator, type Page } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

const ROOM = "ADH-375overlays33cc44dd";
const ROOM_TITLE = "Overlay Room";
const PARTNER = "Sheet Wren";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

const OVERFLOW = "More conversation actions";

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (b === null) {
    throw new Error("element has no bounding box");
  }
  return b;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

/** What has focus, by its accessible label — the overlays hand it back to the
 * control that opened them. */
async function focusedLabel(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? null,
  );
}

/** Reach a control through the ⋯ overflow — where every one of them lives on a
 * phone (spec §3 keeps exactly two chips on the row). */
async function fromOverflowMenu(page: Page, name: string) {
  await page.getByRole("button", { name: OVERFLOW }).click();
  await page
    .getByRole("dialog", { name: OVERFLOW })
    .getByRole("button", { name })
    .click();
}

/** A panel over the conversation: full height, flush right, inside the
 * viewport, and leaving a sliver of the conversation to tap on. */
async function expectFullHeightOverlay(page: Page, panel: Locator) {
  // It slides in over 0.15s, so settle on where it lands first: a box measured
  // mid-animation is one transform away from the panel's real geometry.
  await expect
    .poll(async () => {
      const settling = await box(panel);
      return Math.round(settling.x + settling.width);
    })
    .toBe(PHONE.width);
  const b = await box(panel);
  expect(b.y).toBeLessThanOrEqual(1);
  expect(b.height).toBeGreaterThan(PHONE.height - 2);
  expect(b.width).toBeLessThan(PHONE.width);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}

test("phone: the member list and the DM profile open as full-height overlays (#375)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "vaneoverlay@example.test", "Vane Overlay");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const partner = await SimClient.connect(
    "sheetwren@example.test",
    "hunter2",
    PARTNER,
  );
  try {
    partner.send("JCH", { channel: ROOM });

    const docked = page.getByRole("complementary", { name: "Members" });
    const overlay = page.getByRole("dialog", { name: "Members" });

    // ── Desktop: the member list is the docked fourth column ─────────────
    await expect(docked).toBeVisible();
    await expect(docked.getByText(PARTNER)).toBeVisible({ timeout: 15_000 });
    await expect(overlay).toHaveCount(0);

    // ── Cross into the phone tier with the conversation open ─────────────
    // The column has nowhere to go, and the preference that governs it is
    // still open — nothing about it may put a roster on this screen.
    await page.setViewportSize(PHONE);
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "conversation",
    );
    await expect(docked).toHaveCount(0);
    await expect(overlay).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // ── The toolbar's member chip opens it, from the ⋯ menu ──────────────
    await fromOverflowMenu(page, "Toggle member list");
    await expect(overlay).toBeVisible();
    await expectFullHeightOverlay(page, overlay);
    await expect(overlay.getByText(PARTNER)).toBeVisible();
    // The log is still there underneath, not replaced by the panel.
    await expect(page.getByTestId("message-log")).toBeVisible();

    // ── Escape closes it, and gives focus back to the opener ─────────────
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    expect(await focusedLabel(page)).toBe(OVERFLOW);

    // ── A tap on the sliver beside it closes it too ──────────────────────
    await fromOverflowMenu(page, "Toggle member list");
    await expect(overlay).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(overlay).toHaveCount(0);

    // ── …and so does the panel's own ✕ ───────────────────────────────────
    await fromOverflowMenu(page, "Toggle member list");
    await page.getByRole("button", { name: "Close Members" }).click();
    await expect(overlay).toHaveCount(0);

    // ── Leaving the conversation puts it away for good ───────────────────
    // Transient and per-visit: the trip out to the list and back must not
    // bring the panel with it, the way a persisted preference would. Back is
    // the browser's own (the Android back gesture) — the one way out of a
    // conversation that doesn't go through closing the panel first, since the
    // backdrop covers the toolbar while it is up.
    await fromOverflowMenu(page, "Toggle member list");
    await expect(overlay).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "list",
    );
    await expect(overlay).toHaveCount(0);
    await page
      .getByRole("link", { name: new RegExp(ROOM_TITLE) })
      .first()
      .click();
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "conversation",
    );
    await expect(overlay).toHaveCount(0);

    // ── The DM profile is the same overlay ───────────────────────────────
    partner.send("PRI", {
      recipient: "Vane Overlay",
      message: "Panels, then.",
    });
    await page.getByRole("link", { name: "Back to conversations" }).click();
    await page
      .getByRole("link", { name: new RegExp(PARTNER) })
      .first()
      .click();
    await expect(page).toHaveURL(/\/dm\/Sheet(%20|\+)Wren$/);

    const profileLabel = `Profile: ${PARTNER}`;
    const profile = page.getByRole("dialog", { name: profileLabel });
    // Closed on arrival, whatever the wide layout's sidebar preference says.
    await expect(profile).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: profileLabel }),
    ).toHaveCount(0);

    await fromOverflowMenu(page, "Toggle profile panel");
    await expect(profile).toBeVisible();
    await expectFullHeightOverlay(page, profile);
    await expect(
      profile.getByRole("button", { name: "Open full profile" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(profile).toHaveCount(0);
    expect(await focusedLabel(page)).toBe(OVERFLOW);

    // ── Back to the desktop grid: the docked columns, unchanged ──────────
    await page.setViewportSize(DESKTOP);
    await expect(
      page.getByRole("complementary", { name: profileLabel }),
    ).toBeVisible();
    await expect(profile).toHaveCount(0);
    await page.getByRole("link", { name: new RegExp(ROOM_TITLE) }).click();
    await expect(docked).toBeVisible();
    await expect(overlay).toHaveCount(0);

    // ── …and the panel still fits the screen at 125% interface scale ─────
    // The pref puts `zoom` on :root, which `vw` is blind to (#388): an
    // uncorrected 88vw panel paints 1.25× as wide, runs off the left edge and
    // takes the tap-to-close sliver with it. Set through the pref itself, and
    // measured in the visual pixels the user actually has.
    await page.getByRole("button", { name: "Preferences" }).click();
    const prefs = page.getByRole("dialog", { name: "Preferences" });
    await prefs.getByRole("button", { name: "Appearance" }).click();
    const increase = prefs.getByRole("button", {
      name: "Increase Interface scale",
    });
    await increase.click();
    await increase.click();
    await expect(prefs.getByText("125%")).toBeVisible();
    await prefs.getByRole("button", { name: "Close preferences" }).click();
    expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe(
      "1.25",
    );

    await page.setViewportSize(PHONE);
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "conversation",
    );
    await fromOverflowMenu(page, "Toggle member list");
    await expect(overlay).toBeVisible();
    await expectFullHeightOverlay(page, overlay);
    // Wholly on screen, with a sliver of conversation left to tap.
    const scaled = await box(overlay);
    expect(scaled.x).toBeGreaterThan(20);
  } finally {
    partner.close();
  }
});
