// The M1 step-10 gate: the full slice against the real server + fchat-sim.
// One browser drives the app as Cindral; a raw sim client plays Birch Rowan
// on the other side of the relay (auth.spec owns Amber Vale — a character
// may only hold one sim connection, so the specs never share one).

import { expect, test } from "@playwright/test";
import {
  SimClient,
  delay,
  interceptAvatars,
  registerAndConnect,
} from "./helpers.js";

/** How many channel messages Birch pumps in to force history pagination
 * (the initial REST page is 50). */
const SEED_COUNT = 70;
/** Above the sim's msg_flood window (50ms in the E2E world). */
const SEED_SPACING_MS = 80;

test("full slice: connect, join, chat both ways, PMs, live members, history scroll", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // Register → identity → connect; the server-held session reaches the sim.
  await registerAndConnect(page, "amber@example.test", "Cindral");

  // ── Join a channel ────────────────────────────────────────────────────
  await page.getByLabel("Join a channel").fill("Frontpage");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Frontpage" })).toBeVisible({
    timeout: 10_000,
  });
  // Human-readable URL scheme (M3): identity by character name, channel by key.
  await expect(page).toHaveURL(/\/app\/Cindral\/c\/Frontpage$/);
  await expect(page.getByText("The sim's default hangout")).toBeVisible();

  // Member list: the three seeded NPCs plus us, grouped with role glyphs.
  const members = page.getByRole("complementary", { name: "Members" });
  await expect(members.getByRole("listitem")).toHaveCount(4);
  await expect(members.getByText("Nyx Firemane")).toBeVisible();
  await expect(members.getByText("Old Greywhisker")).toBeVisible();
  await expect(members.getByText("Cindral")).toBeVisible();

  // ── Member context menu (M6): right-click → §10 menu ──────────────────
  await members.getByText("Nyx Firemane").click({ button: "right" });
  const memberMenu = page.getByRole("menu", { name: "Nyx Firemane menu" });
  await expect(memberMenu).toBeVisible();
  // Frontpage is unowned ("" owner slot) — Nyx is a channel op.
  await expect(memberMenu.getByText("channel op @")).toBeVisible();
  await expect(
    memberMenu.getByRole("menuitem", { name: /View profile/ }),
  ).toHaveAttribute("href", "https://www.f-list.net/c/Nyx%20Firemane");
  await expect(
    memberMenu.getByRole("menuitem", { name: "Ignore" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(memberMenu).not.toBeVisible();

  // Message opens (and routes to) the DM thread; back for the rest.
  await members.getByText("Nyx Firemane").click({ button: "right" });
  await memberMenu.getByRole("menuitem", { name: "Message" }).click();
  await expect(page).toHaveURL(/\/dm\/Nyx%20Firemane$/);
  await expect(
    page.getByRole("heading", { name: "Nyx Firemane" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /Frontpage/ })
    .click();
  await expect(page.getByRole("heading", { name: "Frontpage" })).toBeVisible();

  // ── Send a channel message (persisted, echoed back via the gateway) ───
  const log = page.getByTestId("message-log");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Hello from the ember side");
  await composer.press("Enter");
  await expect(log.getByText("Hello from the ember side")).toBeVisible();
  await expect(composer).toHaveValue("");

  // ── The other side: Birch Rowan joins live ────────────────────────────
  const birch = await SimClient.connect(
    "birch@example.test",
    "hunter2",
    "Birch Rowan",
  );
  try {
    birch.send("JCH", { channel: "Frontpage" });
    // Live member-list update, no refresh.
    await expect(members.getByRole("listitem")).toHaveCount(5);
    await expect(members.getByText("Birch Rowan")).toBeVisible();

    // Receive a channel message.
    birch.send("MSG", { channel: "Frontpage", message: "Evening, all." });
    await expect(log.getByText("Evening, all.")).toBeVisible();

    // ── PMs, both directions ────────────────────────────────────────────
    birch.send("PRI", {
      recipient: "Cindral",
      message: "A word in private?",
    });
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Birch Rowan/ });
    await expect(dmRow).toBeVisible();
    await expect(dmRow).toContainText("1"); // unread badge
    await dmRow.click();
    await expect(log.getByText("A word in private?")).toBeVisible();

    const received = birch.waitFor(
      "PRI",
      (payload: { character: string; message: string }) =>
        payload.character === "Cindral" && payload.message === "On my way.",
    );
    await composer.fill("On my way.");
    await composer.press("Enter");
    await received;

    // ── Seed history past one REST page, then prove scroll-up loads it ──
    await nav.getByRole("link", { name: /Frontpage/ }).click();
    await expect(
      page.getByRole("heading", { name: "Frontpage" }),
    ).toBeVisible();
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      birch.send("MSG", {
        channel: "Frontpage",
        message: `seed #${String(i)}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Reload: the server-held session stayed online (the bouncer property);
    // the deep link routes straight back into Frontpage and the log
    // backfills its latest page over REST.
    await page.reload();
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Cindral · online")).toBeVisible();

    // Scroll to the top repeatedly; each pass pages older history in until
    // the very first message of the conversation is on screen.
    await expect(async () => {
      await log.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(log.getByText("Hello from the ember side")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });
  } finally {
    birch.close();
  }
});
