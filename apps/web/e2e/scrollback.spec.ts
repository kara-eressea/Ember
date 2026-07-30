// Scrollback anchor stability (#360): paging older history in must never
// visibly shift the row the user is reading. The prepend anchor correction
// used to land a frame after paint (useEffect) and bail whenever the user's
// own scroll moved scrollTop mid-settle, so the log shoved down and snapped
// back — a rubberband. The fix paints the correction atomically
// (useLayoutEffect) and compensates row re-measures with a relative delta
// that rides along with live scrolling instead of fighting it.
//
// Owns peat@example.test (Peat Hollow + Reed Hollow): spec files run in
// parallel and a character can hold only one sim connection, so specs never
// share characters.

import { expect, test } from "@playwright/test";
import {
  SimClient,
  delay,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

/** Spec-unique hidden channel. */
const CHANNEL_KEY = "ADH-360scrollbackaa11bb22cc33";
const CHANNEL_TITLE = "Peat Scrollback";
/** Well past the 50-message REST page so several older pages exist to walk. */
const SEED_COUNT = 220;
/** Above the e2e sim's msg_flood (50ms) so no line is throttled away. */
const SEED_SPACING_MS = 70;
/** Max tolerated resting shift of the anchor row across one page load (px).
 * When the fix regresses to a rubberband the whole prepended page (~1300px)
 * carries the reader's row away; a working anchor pin holds it. The bound sits
 * well under a page but above the small, steady settle offset the pin has
 * always left behind (a date divider migrating above the fresh block), so it
 * catches the reader's place being lost without flaking on that residue. */
const ANCHOR_TOLERANCE_PX = 90;

test("scrolling up through history keeps the anchor row fixed (#360)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "peat@example.test", "Peat Hollow");
  await joinChannel(page, CHANNEL_KEY, CHANNEL_TITLE);

  const reed = await SimClient.connect(
    "peat@example.test",
    "hunter2",
    "Reed Hollow",
  );
  try {
    const log = page.getByTestId("message-log");
    // Reed must be in the channel before its lines are accepted.
    const members = page.getByRole("complementary", { name: "Members" });
    reed.send("JCH", { channel: CHANNEL_KEY });
    await expect(members.getByText("Reed Hollow")).toBeVisible({
      timeout: 15_000,
    });
    // Zero-padded so `includes("spool 0007")` never matches "spool 0070":
    // each body is a unique substring we can pin the anchor row to.
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      reed.send("MSG", {
        channel: CHANNEL_KEY,
        message: `spool ${String(i).padStart(4, "0")}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`spool ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Reload so the live buffer (every line received while attached) is
    // dropped: the reattached log backfills only the latest REST page, so the
    // older history is genuinely paged in on scroll-up rather than already
    // resident (the server-held session kept us in the channel).
    await page.reload();
    await expect(
      log.getByText(`spool ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Walk up through several older pages. Each pass scrolls to the top of the
    // loaded content (under the load threshold, which fires the next older
    // page), notes a mid-viewport row's position just before the block lands,
    // then reads it again once everything has settled. Its resting position
    // must stay within tolerance every pass — the load never carries the
    // reader's place away.
    for (let pageLoad = 0; pageLoad < 3; pageLoad += 1) {
      const result = await log.evaluate(async (el, settleMs) => {
        const logTop = () => el.getBoundingClientRect().top;
        const raf = () =>
          new Promise<void>((r) => requestAnimationFrame(() => r()));
        // Viewport-top offset of a given message row, or null if it isn't
        // currently rendered.
        const topOf = (text: string) => {
          for (const row of el.querySelectorAll("[data-index]")) {
            if ((row.textContent ?? "").includes(text)) {
              return row.getBoundingClientRect().top - logTop();
            }
          }
          return null;
        };
        // A message sitting well inside the viewport (~250px down), as
        // {text, top}. Tracking a mid-viewport row rather than the very top one
        // keeps the reference clear of the date divider that migrates above the
        // freshly prepended block; its unique number re-finds it after the load
        // and the whole loaded block shifts rigidly, so a working anchor pin
        // leaves it exactly where it was.
        const TARGET_TOP = 250;
        const anchorRow = () => {
          let best: { text: string; top: number; dist: number } | undefined;
          for (const row of el.querySelectorAll("[data-index]")) {
            const text = row.textContent ?? "";
            const match = /spool \d{4}/.exec(text);
            if (match) {
              const top = row.getBoundingClientRect().top - logTop();
              const dist = Math.abs(top - TARGET_TOP);
              if (best === undefined || dist < best.dist) {
                best = { text: match[0], top, dist };
              }
            }
          }
          return best;
        };

        const heightBefore = el.scrollHeight;
        // Scroll to the top of the loaded content → onScroll pages the next
        // older block in. The prepend lands a few async frames later.
        el.scrollTop = 0;
        // Let the virtualizer render the top-of-content window before the
        // page arrives, so the pre-prepend anchor read is real.
        await raf();
        await raf();

        // Follow the mid-viewport row frame by frame. The frame BEFORE the
        // prepend grows the content is its true pre-load position; once older
        // rows land above it, its viewport position must hold.
        let anchorText: string | undefined;
        let baseline = 0;
        let prepended = false;
        let samples = 0;
        let prev = anchorRow();
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const tick = () => {
            if (!prepended && el.scrollHeight > heightBefore + 200) {
              // The block just landed. Adopt the row that was on top the
              // previous frame as the anchor and measure from where it then
              // sat.
              prepended = true;
              if (prev) {
                anchorText = prev.text;
                baseline = prev.top;
              }
            }
            if (prepended && anchorText !== undefined) {
              if (topOf(anchorText) !== null) {
                samples += 1;
              }
            } else {
              prev = anchorRow();
            }
            const done = prepended
              ? performance.now() - start > settleMs
              : performance.now() - start > settleMs * 2;
            if (done) {
              resolve();
            } else {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        });

        // Let the "Loading older messages…" note clear and the layout come to
        // rest before the final read.
        for (let i = 0; i < 180; i += 1) {
          if (!(el.textContent ?? "").includes("Loading older")) break;
          await raf();
        }
        await raf();
        await raf();
        const restTop = anchorText !== undefined ? topOf(anchorText) : null;

        return {
          prepended,
          restDev: restTop !== null ? Math.abs(restTop - baseline) : -1,
          samples,
        } as const;
      }, 1200);

      // A real older page must have prepended, else the assertion is vacuous.
      expect(result.prepended).toBe(true);
      expect(result.samples).toBeGreaterThan(3);
      // The tracked row sits where it did before the block landed above it —
      // the load never carried the reader's place away.
      expect(result.restDev).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
    }

    // The oldest message is reachable and the jump home still lands cleanly.
    await expect(async () => {
      await log.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(log.getByText("spool 0001", { exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(
      log.getByText(`spool ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    reed.close();
  }
});
