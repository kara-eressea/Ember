// #440: messages arriving in the OPEN conversation while the app window has no
// focus must accrue — sidebar badge, "new since you left" divider — and must
// NOT advance the persisted read cursor. Regaining focus at the live tail is
// what marks them read. The old behaviour marked every arrival read from a
// background window, wiping the backlog on every device.
//
// The blur is emulated by dispatching window focus/blur events: a Playwright
// page holds focus for the whole run, and these are exactly the events the
// app's focus tracker listens to (lib/window-focus.ts), so the store flag
// flips the way it does behind another application. The read cursor itself is
// read back from the history API — badges are local state, and only the
// persisted cursor proves nothing was marked read server-side.
//
// Owns hollisreeve@example.test (Hollis Reeve), linnet@example.test (Linnet
// Crow) and the Quiet Study room: specs never share an account, a character or
// a channel (world.ts).

import type { APIRequestContext } from "@playwright/test";
import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

const ROOM = "ADH-440focusgate11cc22dd33";
const ROOM_TITLE = "Quiet Study";

/** The room's persisted read cursor, straight from the API. */
async function readCursor(
  request: APIRequestContext,
  creds: { email: string; password: string },
): Promise<number | null> {
  const login = await request.post("/api/auth/login", {
    data: { email: creds.email, password: creds.password },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const listed = await request.get("/api/identities", { headers });
  const { identities } = (await listed.json()) as {
    identities: { id: string }[];
  };
  const conversations = await request.get(
    `/api/identities/${identities[0]!.id}/conversations`,
    { headers },
  );
  const body = (await conversations.json()) as {
    conversations: {
      channelKey: string | null;
      lastReadMessageId: number | null;
    }[];
  };
  return (
    body.conversations.find((row) => row.channelKey === ROOM)
      ?.lastReadMessageId ?? null
  );
}

function setWindowFocus(
  page: import("@playwright/test").Page,
  focused: boolean,
): Promise<void> {
  return page.evaluate((on) => {
    window.dispatchEvent(new Event(on ? "focus" : "blur"));
  }, focused);
}

test("an unfocused window accrues unread in the open conversation and holds the read cursor (#440)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  const creds = await provisionAndConnect(
    page,
    "hollisreeve@example.test",
    "Hollis Reeve",
  );
  await joinChannel(page, ROOM, ROOM_TITLE);

  const linnet = await SimClient.connect(
    "linnet@example.test",
    "hunter2",
    "Linnet Crow",
  );
  try {
    linnet.send("JCH", { channel: ROOM });
    const log = page.getByTestId("message-log");
    const row = page
      .getByRole("navigation")
      .getByRole("link", { name: ROOM_TITLE });
    const badge = row.getByTestId("nav-badge");

    // ── Focused: the open conversation is read as it arrives (unchanged) ──
    linnet.send("MSG", { channel: ROOM, message: "read while watching" });
    await expect(log.getByText("read while watching")).toBeVisible({
      timeout: 15_000,
    });
    await expect(badge).toHaveCount(0);
    await expect
      .poll(() => readCursor(request, creds), { timeout: 15_000 })
      .not.toBeNull();
    const cursorWhenFocused = await readCursor(request, creds);

    // Reattach so the log mounts with that cursor: the "new since you left"
    // divider is frozen at attach, so it can only appear on a visit that
    // started with a read backlog.
    await page.reload();
    await expect(page.getByRole("heading", { name: ROOM_TITLE })).toBeVisible({
      timeout: 30_000,
    });
    await expect(log.getByText("read while watching")).toBeVisible({
      timeout: 20_000,
    });

    // ── Unfocused: three messages land in the conversation on screen ──────
    await setWindowFocus(page, false);
    for (let i = 1; i <= 3; i += 1) {
      linnet.send("MSG", {
        channel: ROOM,
        message: `while away #${String(i)}`,
      });
      await delay(150);
    }
    // The log keeps following the tail while backgrounded (#284) …
    await expect(log.getByText("while away #3")).toBeVisible({
      timeout: 15_000,
    });
    // … but nothing is read: badge, divider, and an unmoved server cursor.
    await expect(badge).toHaveText("3");
    await expect(page.getByTestId("new-divider")).toBeVisible();
    await delay(1000); // give a stray ack time to land before we conclude
    expect(await readCursor(request, creds)).toBe(cursorWhenFocused);

    // ── Focus returns while parked at the tail: caught up ────────────────
    await setWindowFocus(page, true);
    await expect(badge).toHaveCount(0);
    await expect
      .poll(() => readCursor(request, creds), { timeout: 15_000 })
      .toBeGreaterThan(cursorWhenFocused!);
  } finally {
    linnet.close();
  }
});
