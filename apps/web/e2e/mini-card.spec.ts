// Mini profile card dismissal and placement (§13). Three behaviours that only
// reproduce with live gateway state and real geometry:
//   - Escape closes the card on the FIRST press even though a message just
//     arrived. The log arms its "mark caught up" Escape action the moment an
//     unread divider appears, which used to land on top of the card in the
//     shared Escape stack and eat the press.
//   - Clicking a different name while a card is open closes that card and
//     opens the new one in the same gesture (there is no click-swallowing
//     overlay any more).
//   - The card lands ON the name at a zoomed interface scale: the popover is
//     fixed inside the root's `zoom`, so uncorrected coordinates get scaled a
//     second time and the card drifts off toward the corner (#388's sibling).
//
// Owns hollyhock@example.test (Hollyhock Vane), tern@example.test (Tern
// Ashby) and its two rooms: specs never share accounts, characters, or
// channels (world.ts).

import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

const ROOM = "ADH-cardsunroom44cc55dd1";
const ROOM_TITLE = "Card Sun Room";
const SIDE_ROOM = "ADH-cardsideroom77ee88ff";
const SIDE_ROOM_TITLE = "Card Side Room";

test("one Escape closes the mini card when a message arrives behind it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "hollyhock@example.test", "Hollyhock Vane");
  await joinChannel(page, ROOM, ROOM_TITLE);
  await joinChannel(page, SIDE_ROOM, SIDE_ROOM_TITLE);

  const tern = await SimClient.connect(
    "tern@example.test",
    "hunter2",
    "Tern Ashby",
  );
  try {
    tern.send("JCH", { channel: ROOM });
    const nav = page.getByRole("navigation");
    const log = page.getByTestId("message-log");
    const members = page.getByRole("complementary", { name: "Members" });

    await nav.getByRole("link", { name: ROOM_TITLE }).click();
    await expect(members.getByText("Tern Ashby")).toBeVisible({
      timeout: 15_000,
    });

    // Read a baseline message, then leave and come back: the log remounts
    // with that message as its frozen read cursor, so the next arrival is
    // genuinely "new" and raises the divider.
    tern.send("MSG", { channel: ROOM, message: "morning light" });
    await expect(log.getByText("morning light", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await delay(1000); // let the read cursor round-trip
    await nav.getByRole("link", { name: SIDE_ROOM_TITLE }).click();
    await expect(
      page.getByRole("heading", { name: SIDE_ROOM_TITLE }),
    ).toBeVisible();
    await nav.getByRole("link", { name: ROOM_TITLE }).click();
    await expect(log.getByText("morning light", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("new-divider")).toHaveCount(0);

    // Open the card from the log nick.
    await log.getByRole("button", { name: "Tern Ashby" }).last().click();
    const card = page.getByRole("dialog", {
      name: "Profile card: Tern Ashby",
    });
    await expect(card).toBeVisible();

    // …and a message lands while it is open: the log's ambient Escape action
    // arms itself right here.
    tern.send("MSG", { channel: ROOM, message: "a bird passes" });
    await expect(log.getByText("a bird passes", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("new-divider")).toBeVisible();

    // One press closes the card — and only the card.
    await page.keyboard.press("Escape");
    await expect(card).not.toBeVisible();
    await expect(page.getByTestId("new-divider")).toBeVisible();

    // The ambient action is still there for the next press.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-divider")).toHaveCount(0);
  } finally {
    tern.close();
  }
});

test("clicking another name swaps the card in one gesture", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "hollyhock@example.test", "Hollyhock Vane");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const tern = await SimClient.connect(
    "tern@example.test",
    "hunter2",
    "Tern Ashby",
  );
  try {
    tern.send("JCH", { channel: ROOM });
    const members = page.getByRole("complementary", { name: "Members" });
    await expect(members.getByText("Tern Ashby")).toBeVisible({
      timeout: 15_000,
    });

    // Tern owns the room, so she sits in the op group ABOVE Hollyhock: a card
    // opened from Hollyhock's row hangs below it and leaves Tern's clickable.
    const hollyhockRow = members
      .getByRole("listitem")
      .filter({ hasText: "Hollyhock Vane" });
    const ternRow = members
      .getByRole("listitem")
      .filter({ hasText: "Tern Ashby" });

    await hollyhockRow.click();
    await expect(
      page.getByRole("dialog", { name: "Profile card: Hollyhock Vane" }),
    ).toBeVisible();

    // A single click on another member: the old card goes, the new one opens.
    await ternRow.click();
    await expect(
      page.getByRole("dialog", { name: "Profile card: Tern Ashby" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Profile card: Hollyhock Vane" }),
    ).toHaveCount(0);

    // Clicking the open card's own row toggles it shut.
    await ternRow.click();
    await expect(
      page.getByRole("dialog", { name: "Profile card: Tern Ashby" }),
    ).toHaveCount(0);
  } finally {
    tern.close();
  }
});

test("the card still lands on the name at 125% interface scale", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "hollyhock@example.test", "Hollyhock Vane");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const tern = await SimClient.connect(
    "tern@example.test",
    "hunter2",
    "Tern Ashby",
  );
  try {
    tern.send("JCH", { channel: ROOM });
    const log = page.getByTestId("message-log");
    const members = page.getByRole("complementary", { name: "Members" });
    await expect(members.getByText("Tern Ashby")).toBeVisible({
      timeout: 15_000,
    });
    tern.send("MSG", { channel: ROOM, message: "measured light" });
    await expect(log.getByText("measured light", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // 100% → 125% through the pref itself (two steps of UI_SCALE_STEPS).
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

    const nick = log.getByRole("button", { name: "Tern Ashby" }).last();
    await nick.click();
    const card = page.getByRole("dialog", { name: "Profile card: Tern Ashby" });
    await expect(card).toBeVisible();

    const anchor = await nick.boundingBox();
    const box = await card.boundingBox();
    const viewport = page.viewportSize();
    if (!anchor || !box || !viewport) {
      throw new Error("expected on-screen geometry");
    }
    // Left-aligned with the name, directly below it (§13 below-start)…
    expect(Math.abs(box.x - anchor.x)).toBeLessThanOrEqual(2);
    expect(box.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
    expect(box.y).toBeLessThanOrEqual(anchor.y + anchor.height + 12);
    // …and wholly inside the viewport, margins included.
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8);

    await page.screenshot({ path: "test-results/mini-card-125.png" });
  } finally {
    tern.close();
  }
});
