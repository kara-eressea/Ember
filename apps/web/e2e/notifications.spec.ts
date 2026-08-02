// Notification inbox (#467): a mention arrives while the user is elsewhere in
// the log, the toolbar's tray chip badges it, opening the inbox clears the
// badge, and clicking the entry jumps the log back to that exact message —
// through the same M9 search-jump machinery. Then a friend request sent over
// the sim's JSON API (which bridges an RTB to the chat socket, as the live
// site does) shows up as a second entry.
//
// Owns hazelmere@example.test (Hazelmere Fen), larkspur@example.test
// (Larkspur Wend) and bindweed@example.test (Bindweed Ash): specs never share
// an account or a character (world.ts).

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
