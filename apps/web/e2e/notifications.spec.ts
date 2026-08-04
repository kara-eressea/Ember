// Notification inbox (#467): a mention arrives while the user is elsewhere in
// the log, the toolbar's tray chip badges it, opening the inbox clears the
// badge, and clicking the entry jumps the log back to that exact message —
// through the same M9 search-jump machinery. Then a friend request sent over
// the sim's JSON API (which bridges an RTB to the chat socket, as the live
// site does) shows up as a second entry.
//
// The second test is the inbox's own actions (#505/#506) across two attached
// browsers: a friend request answered from the entry, and an unseen entry
// deleted — with the other device following both.
//
// Owns hazelmere@example.test (Hazelmere Fen), larkspur@example.test
// (Larkspur Wend), bindweed@example.test (Bindweed Ash), quillon@example.test
// (Quillon Reed), sable@example.test (Sable Arkwright) and
// thimble@example.test (Thimble Ashgrove): specs never share an account or a
// character (world.ts).

import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

/** Spec-unique hidden channel. */
const CHANNEL_KEY = "ADH-467notificationinboxaa11bb22";
const CHANNEL_TITLE = "Hazelmere Inbox";
const CHARACTER = "Hazelmere Fen";
/** Enough ordinary chatter to bury the mention past the 50-row REST page,
 * so the jump has to fetch history rather than scroll a resident buffer. */
const BURY_COUNT = 70;
/** Above the e2e sim's msg_flood (50ms) so no line is throttled away. */
const SEED_SPACING_MS = 70;

/** The second test's own hidden channel — one per spec, never shared. */
const ACTIONS_CHANNEL_KEY = "ADH-505inboxactions9a8b7c6d5e";
const ACTIONS_CHANNEL_TITLE = "Quillon Actions";

/** Sends a friend request over the sim's JSON API, as the website would. */
async function sendFriendRequest(
  account: string,
  source: string,
  dest: string,
): Promise<void> {
  const ticketResponse = await fetch(process.env["FCHAT_SIM_TICKET_URL"]!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ account, password: "hunter2" }).toString(),
  });
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const base = new URL(process.env["FCHAT_SIM_TICKET_URL"]!);
  const sent = await fetch(
    new URL("/json/api/request-send.php", base.origin).toString(),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        account,
        ticket,
        source_name: source,
        dest_name: dest,
      }).toString(),
    },
  );
  const body = (await sent.json()) as { error: string };
  expect(body.error).toBe("");
}

test("the inbox logs a mention, badges it, and jumps back to it (#467)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "hazelmere@example.test", CHARACTER);
  await joinChannel(page, CHANNEL_KEY, CHANNEL_TITLE);

  const larkspur = await SimClient.connect(
    "larkspur@example.test",
    "hunter2",
    "Larkspur Wend",
  );
  try {
    const log = page.getByTestId("message-log");
    const members = page.getByRole("complementary", { name: "Members" });
    larkspur.send("JCH", { channel: CHANNEL_KEY });
    await expect(members.getByText("Larkspur Wend")).toBeVisible({
      timeout: 15_000,
    });

    // The mention, then a wall of chatter that buries it.
    larkspur.send("MSG", {
      channel: CHANNEL_KEY,
      message: `${CHARACTER}, the kettle is on`,
    });
    await expect(log.getByText(`${CHARACTER}, the kettle is on`)).toBeVisible({
      timeout: 15_000,
    });
    for (let i = 1; i <= BURY_COUNT; i += 1) {
      larkspur.send("MSG", {
        channel: CHANNEL_KEY,
        message: `filler ${String(i).padStart(3, "0")}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`filler ${String(BURY_COUNT).padStart(3, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Reload so the live buffer is dropped: the log backfills only the latest
    // REST page, so the mention is genuinely off the buffer and the jump has
    // to page it back in from the server.
    await page.reload();
    await expect(
      log.getByText(`filler ${String(BURY_COUNT).padStart(3, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(log.getByText(`${CHARACTER}, the kettle is on`)).toHaveCount(
      0,
    );

    // The bell badges the unseen mention — off the ready frame, before the
    // inbox has ever been opened.
    const chip = page.getByRole("button", { name: /^Notifications/ });
    await expect(chip).toHaveAccessibleName("Notifications — 1 unseen", {
      timeout: 15_000,
    });

    await chip.click();
    const panel = page.getByRole("dialog", { name: "Notifications" });
    const mentionRow = panel.getByText(
      `Larkspur Wend mentioned you in #${CHANNEL_TITLE}`,
    );
    await expect(mentionRow).toBeVisible({ timeout: 10_000 });
    // Opening marks everything seen (the Discord model).
    await expect(chip).toHaveAccessibleName("Notifications", {
      timeout: 10_000,
    });

    // Clicking the entry closes the panel and lands the log on the message.
    await mentionRow.click();
    await expect(panel).toBeHidden();
    await expect(log.getByText(`${CHARACTER}, the kettle is on`)).toBeVisible({
      timeout: 15_000,
    });

    // A friend request over the website bridge becomes a second entry — and
    // badges again, because the watermark only covered what was there.
    await sendFriendRequest("bindweed@example.test", "Bindweed Ash", CHARACTER);
    await expect(chip).toHaveAccessibleName("Notifications — 1 unseen", {
      timeout: 15_000,
    });
    await chip.click();
    await expect(
      panel.getByText("Bindweed Ash sent a friend request"),
    ).toBeVisible({ timeout: 10_000 });
    // The log entry persists after it is read — this is a log, not a to-do
    // list, so the mention is still there under it.
    await expect(
      panel.getByText(`Larkspur Wend mentioned you in #${CHANNEL_TITLE}`),
    ).toBeVisible();
  } finally {
    larkspur.close();
  }
});

test("answers a friend request from the entry and deletes a log line, on two devices (#505, #506)", async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  const character = "Quillon Reed";
  const creds = await provisionAndConnect(
    page,
    "quillon@example.test",
    character,
  );
  // The inbox chip lives on the conversation toolbar, so both devices need a
  // conversation open to have one. Nobody else ever speaks in here — the
  // spec's subject is the inbox, not the log.
  await joinChannel(page, ACTIONS_CHANNEL_KEY, ACTIONS_CHANNEL_TITLE);

  // A second attached browser on the same account: the inbox is server-held
  // state, so everything one device does to it has to land on the other.
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    await interceptAvatars(pageB);
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(creds.email);
    await pageB.getByLabel("Password").fill(creds.password);
    await pageB.getByRole("button", { name: "Log in" }).click();
    await expect(pageB).toHaveURL(/\/identities$/);
    // The session is already live (device A connected it) → Open.
    await pageB.getByRole("button", { name: "Open", exact: true }).click();
    await expect(pageB).toHaveURL(/\/app\//);
    // The channel is the identity's, not the device's: B finds it already in
    // the sidebar and opens it for the toolbar.
    await pageB
      .getByRole("navigation")
      .getByRole("link", { name: new RegExp(ACTIONS_CHANNEL_TITLE) })
      .click({ timeout: 15_000 });
    await expect(
      pageB.getByRole("heading", { name: ACTIONS_CHANNEL_TITLE }),
    ).toBeVisible({ timeout: 15_000 });

    const chipA = page.getByRole("button", { name: /^Notifications/ });
    const chipB = pageB.getByRole("button", { name: /^Notifications/ });

    // ── A friend request, answered from the inbox entry (#505) ───────────
    await sendFriendRequest("sable@example.test", "Sable Arkwright", character);
    await expect(chipA).toHaveAccessibleName("Notifications — 1 unseen", {
      timeout: 15_000,
    });

    await chipA.click();
    const panelA = page.getByRole("dialog", { name: "Notifications" });
    await expect(
      panelA.getByText("Sable Arkwright sent a friend request"),
    ).toBeVisible({ timeout: 10_000 });
    await panelA
      .getByRole("button", {
        name: "Accept friend request from Sable Arkwright",
      })
      .click();
    // The entry resolves in place — it stays in the log, it just stops
    // asking.
    await expect(panelA.getByText("Accepted")).toBeVisible({
      timeout: 15_000,
    });
    // …and the accept really went upstream: no surface still offers it,
    // including the sidebar's own request row behind the panel.
    await expect(
      page.getByRole("button", {
        name: "Accept friend request from Sable Arkwright",
      }),
    ).toHaveCount(0, { timeout: 15_000 });

    // ── An unseen entry, deleted while both devices are attached (#506) ──
    // The panel is still open, so opening it does not sweep this one under
    // the seen watermark: it arrives unseen on BOTH devices, which is the
    // only way to find out whether the badge settles coherently.
    await sendFriendRequest(
      "thimble@example.test",
      "Thimble Ashgrove",
      character,
    );
    await expect(
      panelA.getByText("Thimble Ashgrove sent a friend request"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(chipA).toHaveAccessibleName("Notifications — 1 unseen");
    await expect(chipB).toHaveAccessibleName("Notifications — 1 unseen", {
      timeout: 15_000,
    });

    const bins = panelA.getByRole("button", { name: "Remove notification" });
    // Newest first (the panel head says so), so the entry that just arrived
    // is the top row and its trashcan is the first one.
    await expect(bins).toHaveCount(2);
    await bins.first().click();
    await expect(
      panelA.getByText("Thimble Ashgrove sent a friend request"),
    ).toBeHidden({ timeout: 15_000 });
    // The other entry is untouched: this deletes one line, not the log.
    await expect(
      panelA.getByText("Sable Arkwright sent a friend request"),
    ).toBeVisible();
    // Both badges settle on the server's recount, not on a guess each.
    await expect(chipA).toHaveAccessibleName("Notifications", {
      timeout: 15_000,
    });
    await expect(chipB).toHaveAccessibleName("Notifications", {
      timeout: 15_000,
    });

    // ── What device B sees when it finally looks ─────────────────────────
    await chipB.click();
    const panelB = pageB.getByRole("dialog", { name: "Notifications" });
    await expect(
      panelB.getByText("Sable Arkwright sent a friend request"),
    ).toBeVisible({ timeout: 10_000 });
    // Resolved on the other device, derived here from B's own live request
    // list — no verdict travelled with the row.
    await expect(panelB.getByText("Accepted")).toBeVisible({ timeout: 15_000 });
    await expect(
      panelB.getByText("Thimble Ashgrove sent a friend request"),
    ).toHaveCount(0);
  } finally {
    await contextB.close();
  }
});
