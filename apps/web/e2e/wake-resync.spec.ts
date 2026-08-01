// Sleep → wake → reconnect with a gap (#432). When the catch-up replay outran
// the budget the server flags the first frame `gap: true`, and the client
// replaces that conversation's buffer with the replayed window — the old
// prefix is no longer contiguous with it. That reset used to leave a MOUNTED
// log unusable: it dropped back to "Loading…", and scroll-back plus auto-fill
// both bail in that state, so the missed span was unreachable until the user
// navigated away and back. Here the log must heal itself.
//
// A budget-clamped gap needs thousands of messages to provoke for real (that
// arithmetic is unit-tested), so the spec proxies the gateway socket and
// speaks the server's own frame back into the page — everything downstream of
// it, including the scroll-back pages, is the real stack.
//
// Owns gorse@example.test (Gorse Fell) and teasel@example.test (Teasel
// Crake): specs run in parallel and a character holds one sim connection, so
// specs never share characters.

import type { MessageDto } from "@emberchat/protocol";
import {
  delay,
  expect,
  interceptAvatars,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

/** Well past one page (50), so healing the reset needs several. */
const WAVE_COUNT = 60;
/** Above the e2e sim's msg_flood (50ms) so no wave is throttled away. */
const WAVE_SPACING_MS = 80;
/** How much of the tail the "budget-clamped" replay carries. */
const REPLAY_TAIL = 3;

interface Seen {
  identityId: string;
  messages: MessageDto[];
}

test("a gap catch-up leaves the log able to page the missed span back in", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // Proxy the gateway both ways, recording the live messages as they pass so
  // the injected frame carries real DTOs, and keeping a handle to push frames
  // at the page. Reconnects re-enter this handler; the latest socket wins.
  const seen = new Map<string, Seen>();
  let inject: ((frame: unknown) => void) | undefined;
  await page.routeWebSocket(/\/gateway/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      record(seen, message);
      ws.send(message);
    });
    inject = (frame) => {
      ws.send(JSON.stringify(frame));
    };
  });

  await provisionAndConnect(page, "gorse@example.test", "Gorse Fell");

  const teasel = await SimClient.connect(
    "teasel@example.test",
    "hunter2",
    "Teasel Crake",
  );
  try {
    teasel.send("PRI", { recipient: "Gorse Fell", message: "hello there" });
    const nav = page.getByRole("navigation");
    await nav.getByRole("link", { name: /Teasel Crake/ }).click();
    const log = page.getByTestId("message-log");
    await expect(log.getByText("hello there")).toBeVisible();

    for (let i = 1; i <= WAVE_COUNT; i += 1) {
      teasel.send("PRI", {
        recipient: "Gorse Fell",
        message: `wave #${String(i)}`,
      });
      await delay(WAVE_SPACING_MS);
    }
    await expect(
      log.getByText(`wave #${String(WAVE_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // ── The wake reconnect's catch-up comes back gap-flagged ───────────────
    const [convId, conversation] = [...seen.entries()].at(-1)!;
    expect(conversation.messages.length).toBeGreaterThan(REPLAY_TAIL);
    inject!({
      t: "catchup",
      d: {
        identityId: conversation.identityId,
        convId,
        messages: conversation.messages.slice(-REPLAY_TAIL),
        done: true,
        gap: true,
      },
    });

    // The replayed window is a usable log, not a spinner.
    await expect(log.getByText("Loading…")).toHaveCount(0);
    await expect(
      log.getByText(`wave #${String(WAVE_COUNT)}`, { exact: true }),
    ).toBeVisible();

    // …and scrolling up walks the missed span back in, page by page, all the
    // way past the first wave to the message read before the gap.
    await expect(async () => {
      await log.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(log.getByText("wave #1", { exact: true })).toBeVisible({
        timeout: 1_000,
      });
      await expect(log.getByText("hello there")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 30_000 });

    // Escape returns to the newest message — the buffer is one contiguous
    // history, not two stitched windows with a hole between them.
    await page.keyboard.press("Escape");
    await expect(
      log.getByText(`wave #${String(WAVE_COUNT)}`, { exact: true }),
    ).toBeVisible();
  } finally {
    teasel.close();
  }
});

/** Collect live message DTOs per conversation from the gateway stream. */
function record(seen: Map<string, Seen>, raw: string | Buffer): void {
  let frame: unknown;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const parsed = frame as {
    t?: string;
    d?: {
      identityId?: string;
      kind?: string;
      d?: { convId?: string; message?: MessageDto };
    };
  };
  if (parsed.t !== "event" || parsed.d?.kind !== "message.new") {
    return;
  }
  const { identityId } = parsed.d;
  const convId = parsed.d.d?.convId;
  const message = parsed.d.d?.message;
  if (identityId === undefined || convId === undefined || !message) {
    return;
  }
  const entry = seen.get(convId) ?? { identityId, messages: [] };
  entry.messages.push(message);
  seen.set(convId, entry);
}
