// The phone tier on an actual phone (#375, MP1 package G): this file runs in
// the `mobile-chromium` project, a Pixel-class device context — 393×727,
// `isMobile`, `hasTouch`, coarse pointer, no hover — and never resizes the
// viewport. The two specs that *cross* the tier boundary (pane-stack,
// phone-overlays) stay in the desktop project; these are the paths that are
// only ever walked on a phone, and the daily-driver one nothing exercised at
// this width before: the toolbar has collapsed to two chips, so send a
// message and read the log with what is left.
//
// …and, since MP4 (#378), in `mobile-webkit` too — an iPhone-class descriptor
// on the other engine, where the same two paths are the ones a real phone user
// would walk first. It costs nothing but a browser: nothing in here is CDP.
//
// Owns pocket@example.test (Pocket Chase), slateburn@example.test (Slate Burn)
// and the Pocket Room: spec files run in parallel and a character holds one
// sim connection, so specs share neither.

import { type Locator, type Page } from "@playwright/test";
import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

/** Mirrors AT_BOTTOM_SLACK_PX in MessageLog — within this counts as bottom. */
const AT_BOTTOM_SLACK_PX = 60;
/** Mirrors --eb-popover-margin: how close to the edge a surface may come. */
const POPOVER_MARGIN = 8;

const ROOM = "ADH-375mobileshell66aa77bb";
const ROOM_TITLE = "Pocket Room";
const PARTNER = "Slate Burn";

const OVERFLOW = "More conversation actions";

/** Long enough to wrap several times at 393px, so the tail assertions are
 * about a log that genuinely overflows rather than one that fits. */
function seedLine(n: number): string {
  const long =
    "A line long enough to wrap two or three times on a phone, which is what " +
    "makes the distance from the bottom worth measuring at all. ";
  return `Line ${String(n)} ${n % 2 === 0 ? long : "short"}`;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (b === null) {
    throw new Error("element has no bounding box");
  }
  return b;
}

function distanceFromBottom(page: Page) {
  return page
    .getByTestId("message-log")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** The page must never scroll sideways on a phone. */
function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

/** The conversation toolbar — no test id of its own, and none is worth adding
 * for this: the ⋯ chip lives in exactly one row. */
function toolbar(page: Page): Locator {
  return page
    .locator("header")
    .filter({ has: page.getByRole("button", { name: OVERFLOW }) });
}

/** Every control the toolbar is carrying *inline*, by accessible label, with
 * the inbox's unseen count normalised away. */
async function inlineControls(page: Page): Promise<string[]> {
  const labels = await toolbar(page)
    .locator('button, [role="button"]')
    .evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("aria-label") ?? ""),
    );
  return labels.map((label) => label.split(" — ")[0] ?? label);
}

test("phone device: two chips inline, everything else through ⋯, and the composer still works (#375)", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "pocket@example.test", "Pocket Chase");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const partner = await SimClient.connect(
    "slateburn@example.test",
    "hunter2",
    PARTNER,
  );
  try {
    partner.send("JCH", { channel: ROOM });
    await delay(500);
    // Spacing stays above the sim's 50ms msg_flood so no line is throttled.
    for (let i = 1; i <= 24; i += 1) {
      partner.send("MSG", { channel: ROOM, message: seedLine(i) });
      await delay(70);
    }

    const log = page.getByTestId("message-log");
    const menu = page.getByRole("dialog", { name: OVERFLOW });

    // ── This really is a phone, not a narrow desktop ─────────────────────
    // The device properties the tier and the touch fallbacks key off, read
    // back from the page rather than assumed from the project name — a
    // descriptor that stopped emulating touch would otherwise let every
    // assertion below pass for the wrong reason.
    const device = await page.evaluate(() => ({
      width: window.innerWidth,
      noHover: matchMedia("(hover: none)").matches,
      coarse: matchMedia("(pointer: coarse)").matches,
      touchEvents: "ontouchstart" in window,
      touchPoints: navigator.maxTouchPoints,
    }));
    // The layout viewport follows the device only because index.html asks it
    // to (`width=device-width`); without that meta tag mobile emulation lays
    // the page out at ~980px — measured, on both engines — and the phone tier
    // never engages.
    expect(device.width).toBeLessThan(768);
    expect(device).toMatchObject({ noHover: true, coarse: true });
    // `ontouchstart` rather than `maxTouchPoints`, because the two engines
    // disagree and only one of them is right (MP4, #378): Playwright's WebKit
    // build reports `maxTouchPoints: 0` under an iPhone descriptor that is
    // otherwise fully touch-enabled, where a real iPhone reports 5. The
    // presence of the event handler is what both agree on, and it is the
    // stronger claim anyway — the events exist. Nothing in the app reads
    // `maxTouchPoints`; its capability probe is `(hover: none)`
    // (lib/pointer.ts), asserted on the line above.
    expect(device.touchEvents).toBe(true);
    if (browserName === "chromium") {
      expect(device.touchPoints).toBeGreaterThan(0);
    }
    await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "conversation",
    );

    await expect(log.getByText("Line 24", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // ── Exactly two chips on the row, plus the way back and the way to the
    //    rest (spec §3) ───────────────────────────────────────────────────
    expect(await inlineControls(page)).toEqual([OVERFLOW, "Notifications"]);
    // The way back out of the pane is a <Link>, so it is not in that list.
    await expect(
      toolbar(page).getByRole("link", { name: "Back to conversations" }),
    ).toBeVisible();
    // The search field is the second survivor — a `role=search` form the
    // narrow tier paints as a magnifier until it takes focus.
    const search = toolbar(page).getByRole("search");
    await expect(search).toBeVisible();
    const parked = await box(search);
    const searchInput = search.getByRole("textbox", { name: "Search log" });
    await searchInput.focus();
    await expect
      .poll(async () => (await box(search)).width)
      .toBeGreaterThan(parked.width);
    await searchInput.blur();
    await expect
      .poll(async () => (await box(search)).width)
      .toBeLessThanOrEqual(parked.width);

    // ── …and everything else is in the ⋯ menu, which fits the screen ─────
    await page.getByRole("button", { name: OVERFLOW }).click();
    await expect(menu).toBeVisible();
    for (const name of ["Pin", "Mute conversation", "Toggle member list"]) {
      await expect(menu.getByRole("button", { name })).toBeVisible();
    }
    // Package E's cap: an anchored surface near the right edge stays inside
    // the viewport with its margin, and never lengthens the page sideways.
    const menuBox = await box(menu);
    expect(menuBox.x).toBeGreaterThanOrEqual(POPOVER_MARGIN - 1);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
      device.width - POPOVER_MARGIN + 1,
    );
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // ── The daily driver: type, send, read it back, still at the tail ────
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Sent from the pocket.");
    await composer.press("Enter");
    await expect(log.getByText("Sent from the pocket.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(composer).toHaveValue("");
    await expect
      .poll(() => distanceFromBottom(page))
      .toBeLessThan(AT_BOTTOM_SLACK_PX);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // ── A profile card opens from a log nick and stays on screen ─────────
    await log.getByRole("button", { name: PARTNER }).last().click();
    const card = page.getByRole("dialog", { name: `Profile card: ${PARTNER}` });
    await expect(card).toBeVisible();
    const cardBox = await box(card);
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(device.width);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");

    // ── One control end-to-end from the menu: mute ───────────────────────
    // Reachable nowhere else on this tier, so if the menu doesn't drive it,
    // a phone cannot mute a conversation at all.
    await page.getByRole("button", { name: OVERFLOW }).click();
    await menu.getByRole("button", { name: "Mute conversation" }).click();
    await expect(menu).toHaveCount(0); // a choice closes the menu
    await page.getByRole("button", { name: OVERFLOW }).click();
    await expect(
      menu.getByRole("button", { name: "Unmute conversation" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");

    // …and it is a real preference, not a chip that lit up: the sidebar row
    // shows nothing either way (muted conversations keep accruing badges by
    // design), so read it back where it is visible — the Notifications pane,
    // reached through the phone's full-screen Preferences stopgap (spec §4).
    await page.getByRole("link", { name: "Back to conversations" }).click();
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "list",
    );
    await page.getByRole("button", { name: "Preferences" }).click();
    const prefs = page.getByRole("dialog", { name: "Preferences" });
    await prefs.getByRole("button", { name: "Notifications" }).click();
    await expect(
      prefs.getByRole("button", { name: `Unmute # ${ROOM_TITLE}` }),
    ).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  } finally {
    partner.close();
  }
});

// The install surface (MP3 §1, #377). Cheap and login-free: the manifest is
// public and the question is only whether the wiring holds end to end — the
// document points at it, the dev server's proxy reaches the Fastify route the
// way production's single server does, and the icons it names are actually
// served. The name assertion that matters lives in the server's own test
// (plugins/web-manifest.test.ts); here the check is that the manifest and the
// document agree, which is what would break if either side stopped reading the
// one product-name constant (#556).
test("installable: the document links a manifest whose icons resolve (#377)", async ({
  page,
}) => {
  await page.goto("/");

  // The one login-free page in the mobile tier, and therefore the only place
  // MP1 §2's boot-order claim is falsifiable (MP4, #378): the tier is stamped
  // from `main.tsx` right after `applyInterface`, not from an `AppShell`
  // effect, *so that* the screens outside the shell — login, the identity
  // picker — are tiered too and nothing paints untiered. Every other
  // `data-layout` assertion in the suite runs after `provisionAndConnect`, so
  // an effect-based stamp would have passed all of them.
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/apple-touch-icon.png",
  );

  const response = await page.request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = (await response.json()) as {
    name: string;
    display: string;
    icons: { src: string }[];
    shortcuts: { url: string; icons: { src: string }[] }[];
  };
  expect(manifest.display).toBe("standalone");
  // index.html and the manifest route are two spellings of `APP_NAME`, and a
  // guard in the web suite keeps the markup honest; this is the end-to-end
  // half of that pair.
  await expect(page).toHaveTitle(manifest.name);
  expect(manifest.shortcuts.length).toBeGreaterThan(0);

  for (const src of [
    ...manifest.icons.map((icon) => icon.src),
    ...manifest.shortcuts.flatMap((shortcut) =>
      shortcut.icons.map((icon) => icon.src),
    ),
    "/icons/apple-touch-icon.png",
  ]) {
    const icon = await page.request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()["content-type"], src).toContain("image/png");
  }
});
