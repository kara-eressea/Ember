// The two things an installed iPhone did to the app that no emulator reports
// (#533, #534). Runs in `mobile-chromium` and, the point of the exercise, in
// `mobile-webkit` — an iPhone-class descriptor on the engine both bugs belong
// to. Nothing in here is CDP.
//
// Neither test can *reproduce* its bug: `display-mode: standalone` is not
// emulatable (MP3 §8, base.test.ts says the same at more length) and
// `env(safe-area-inset-*)` is 0 on every automatable context, so the strips
// these fixes paint do not exist here, and iOS's focus-zoom is a decision the
// OS makes about a page it has already laid out. What both tests pin is the
// *precondition* each fix establishes — a canvas that carries the theme's
// ground, and a form control that never asks to be zoomed — which is the half
// a machine can check and the half that regresses silently. The other half is
// design/mobile-device-checklist.md.
//
// Owns chalkmere@example.test (Chalk Mere) and the Chalk Room: spec files run
// in parallel and a character holds one sim connection, so specs share neither.

import { type Page } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  test,
} from "./helpers.js";

const ACCOUNT = "chalkmere@example.test";
const CHARACTER = "Chalk Mere";
const ROOM = "ADH-533iosshell5c3d4e5f";
const ROOM_TITLE = "Chalk Room";

/** iOS zooms the page when a focused text control renders below this. */
const IOS_ZOOM_FLOOR_PX = 16;

/**
 * `--eb-bg` as the engine resolves it, in the same `rgb(…)` spelling
 * `backgroundColor` comes back in.
 *
 * Read off a probe element rather than parsed out of the custom property: the
 * property's value is a hex literal from tokens.ts and the computed background
 * is a resolved colour, and normalising one to the other by hand is a second
 * implementation of the thing under test. Letting the engine resolve
 * `background: var(--eb-bg)` once, somewhere the theme is in force, gives the
 * comparison for free.
 */
function themeGround(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--eb-bg)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  });
}

function canvasBackgrounds(page: Page) {
  return page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
  }));
}

test("phone device: the document canvas carries the theme's ground, not a transparent one (#533)", async ({
  page,
}) => {
  await interceptAvatars(page);

  // The login screen, unauthenticated, on purpose: no server prefs have
  // arrived, so the base theme is whatever localStorage says, which is the one
  // lever this test has on it. It is also the screen an installed app opens on
  // the first time, and the one the black bands were photographed around.
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");

  const dark = await canvasBackgrounds(page);
  const darkGround = await themeGround(page);

  // The bug, stated as an assertion: `html` had no background of its own, and
  // in a browser tab nothing noticed because css-backgrounds-3 propagates
  // `body`'s up to the canvas and `body` covers the viewport anyway. An
  // installed window under `viewport-fit=cover` fills the safe-area strips
  // from the root element's colour, and a transparent root gets black ones.
  expect(dark.html).toBe(darkGround);
  expect(dark.body).toBe(darkGround);
  expect(dark.html).not.toBe("rgba(0, 0, 0, 0)");

  // …and it is the *theme's* ground, not a literal that happens to match the
  // default. Parchment is the light base theme, so a canvas still painted the
  // dark value after the switch is a canvas that stopped following the theme.
  await page.addInitScript(() => {
    localStorage.setItem("eb.baseTheme", "parchment");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");

  const light = await canvasBackgrounds(page);
  const lightGround = await themeGround(page);

  expect(light.html).toBe(lightGround);
  expect(light.body).toBe(lightGround);
  expect(lightGround).not.toBe(darkGround);
});

/**
 * Every text-entry control on screen that renders below the floor, as
 * `<tag>[type] name — 13.5px` lines.
 *
 * A sweep rather than a list of locators, for the reason the touch-target
 * sweep is one: the guard has to hold for controls nobody thought about,
 * including the ones a later round adds. The exclusions are the boxes that
 * carry no text — iOS does not zoom for them, and several modules size their
 * box in `em`, so a floor there would be a redesign.
 */
function undersizedControls(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((min) => {
    const selector =
      'input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="hidden"]), textarea, select, [contenteditable="true"]';
    const undersized: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = element.getBoundingClientRect();
      // Nothing that is not on screen: a control inside a closed surface is
      // display:none, has no box, and would be reported at the UA default.
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < min) {
        const type = element.getAttribute("type");
        const label =
          element.getAttribute("aria-label") ??
          element.getAttribute("name") ??
          element.getAttribute("placeholder") ??
          element.className;
        undersized.push(
          `${element.tagName.toLowerCase()}${type === null ? "" : `[${type}]`}` +
            ` ${label} — ${String(size)}px`,
        );
      }
    }
    return undersized;
  }, floor);
}

test("phone device: no text control renders under the size iOS zooms for (#534)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // The login form first, and separately, because it is where the reported
  // symptom starts: it is the first screen of a fresh install, its two fields
  // were 13.5px, and tapping one of them is the first thing anybody does.
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(await undersizedControls(page, IOS_ZOOM_FLOOR_PX)).toEqual([]);

  await provisionAndConnect(page, ACCOUNT, CHARACTER);
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");

  // Preferences before the channel, and that order is not arbitrary: the
  // toolbar button lives in the sidebar head, and this tier hides the sidebar
  // outright once a conversation is open (mp3-pwa.md §5 says the same about
  // the reconnect chip). Opened from the list pane it is reachable; opened
  // after joining it is not on screen at all.
  await page.getByRole("button", { name: "Preferences" }).tap();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await expect(prefs).toBeVisible();
  expect(await undersizedControls(page, IOS_ZOOM_FLOOR_PX)).toEqual([]);

  // Highlights is the pane with the most text entry in the app.
  const rail = prefs.getByRole("navigation", { name: "Preference sections" });
  await rail.getByRole("button", { name: "Highlights" }).tap();
  await expect(
    prefs.getByRole("heading", { name: "Highlights" }),
  ).toBeVisible();
  expect(await undersizedControls(page, IOS_ZOOM_FLOOR_PX)).toEqual([]);
  await prefs.getByRole("button", { name: "Close preferences" }).tap();
  await expect(prefs).not.toBeVisible();

  // The composer last — the app's most-used text box, and a `textarea`, which
  // is the control the floor has to reach through `font: inherit` rather than
  // a declaration of its own.
  await joinChannel(page, ROOM, ROOM_TITLE);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  expect(await undersizedControls(page, IOS_ZOOM_FLOOR_PX)).toEqual([]);
});
