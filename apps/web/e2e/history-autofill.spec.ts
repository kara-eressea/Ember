// History auto-fill for short logs (#405): when the latest REST page does not
// fill the viewport (a deep-history channel opened in a very TALL window), the
// log never overflows, so there is no scrollbar and scrolling up can never
// fire the next older page — earlier history is unreachable. A background
// auto-fill loop must keep paging older history in until the log overflows its
// viewport (or history is exhausted), with no user scroll at all.
//
// This regressed on v0.16.0 via the #402 history-load-jump rework. The spec
// seeds a deep history, reloads so only the latest page is resident, opens the
// channel in a tall viewport that the latest page underfills, and asserts the
// log keeps loading older messages until it overflows.
//
// Owns moss@example.test (Moss Fen + Reed Marsh): spec files run in parallel
// and a character can hold only one sim connection, so specs never share
// characters.

import { expect, test } from "@playwright/test";
import {
  SimClient,
  delay,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

/** Spec-unique hidden channel. */
const CHANNEL_KEY = "ADH-405historyautofillcc33dd44";
const CHANNEL_TITLE = "Moss History Autofill";
/** Several REST pages deep (PAGE_SIZE is 50), so auto-fill has plenty to pull. */
const SEED_COUNT = 200;
/** Above the e2e sim's msg_flood (50ms) so no line is throttled away. */
const SEED_SPACING_MS = 70;

// A very tall window: the latest 50 single-line messages (~20px each, ~1000px)
// come nowhere near filling it, so the initial page cannot overflow the log.
const TALL_VIEWPORT = { width: 1280, height: 3200 } as const;

test("a short log keeps auto-filling older history until it overflows (#405)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "moss@example.test", "Moss Fen");
  await joinChannel(page, CHANNEL_KEY, CHANNEL_TITLE);

  const reed = await SimClient.connect(
    "moss@example.test",
    "hunter2",
    "Reed Marsh",
  );
  try {
    const log = page.getByTestId("message-log");
    const members = page.getByRole("complementary", { name: "Members" });
    reed.send("JCH", { channel: CHANNEL_KEY });
    await expect(members.getByText("Reed Marsh")).toBeVisible({
      timeout: 15_000,
    });
    // Zero-padded so `includes("fill 0007")` never matches "fill 0070".
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      reed.send("MSG", {
        channel: CHANNEL_KEY,
        message: `fill ${String(i).padStart(4, "0")}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`fill ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Grow to a very tall window BEFORE the reattach — mirrors the user's #405
    // repro: restarting the app with an already-maximised 4K window, resuming a
    // fully-read channel whose latest page underfills the viewport.
    await page.setViewportSize(TALL_VIEWPORT);

    // Reload so the live buffer is dropped: the reattached log backfills only
    // the latest REST page (50 messages), which cannot fill the tall viewport.
    await page.reload();
    await expect(
      log.getByText(`fill ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // No scrolling whatsoever from here — the auto-fill loop must do the work.
    // It keeps paging older history until the log overflows its viewport.
    await expect
      .poll(
        async () =>
          log.evaluate((el) => el.scrollHeight > el.clientHeight + 120),
        { timeout: 30_000, message: "log never overflowed via auto-fill" },
      )
      .toBe(true);

    // Older history that was NOT in the latest REST page must now be resident —
    // the latest page was fill 0151–0200, so a row from an earlier page proves
    // real older pages were pulled in, not just the initial backfill.
    await expect(log.getByText("fill 0120", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    reed.close();
  }
});
