// History-load jump (#387): while the user is reading older history and a
// server page is FETCHED in on scroll-up, the reading position must not lurch
// — not while the page is in flight, and not once it lands. #360/#374 made the
// PREPEND paint-atomic, yet three seams on the server-fetch path still shifted
// the reader's line, none caught by scrollback.spec's 90px resting check:
//   1. the "Loading older messages…" note rendered as a static-flow sibling
//      above the virtualized rows, and `.log` sets `overflow-anchor: none`, so
//      it shoved every row down by its own height for the whole fetch;
//   2. the prepend anchor was captured from the PAINTED DOM, which lags the
//      scroll a render — a fast scroll-up or jump anchored a far-off row (or
//      missed it and pinned to the very top);
//   3. the re-pin mixed the virtualizer's coordinate space with viewport px,
//      settling the held row a top-padding low every page.
// This spec seeds a deep history, scrolls up across several server page
// boundaries, and asserts a tracked mid-viewport row never moves more than a
// couple px across the entire load.
//
// Owns sedge@example.test (Sedge Fen + Rush Fen): spec files run in parallel
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
const CHANNEL_KEY = "ADH-387historyloadjumpaa11bb22";
const CHANNEL_TITLE = "Sedge History Load";
/** Well past the 50-message REST page so several server pages exist to walk. */
const SEED_COUNT = 200;
/** Above the e2e sim's msg_flood (50ms) so no line is throttled away. */
const SEED_SPACING_MS = 70;
/** The anchor row must hold within a couple px through the entire load — the
 * in-flight loading note used to shove it down by its own height (~20px). The
 * bound sits far below that shove yet above sub-pixel measurement jitter. */
const TRANSIENT_TOLERANCE_PX = 8;

test("a server history page never lurches the reading position (#387)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "sedge@example.test", "Sedge Fen");
  await joinChannel(page, CHANNEL_KEY, CHANNEL_TITLE);

  const rush = await SimClient.connect(
    "sedge@example.test",
    "hunter2",
    "Rush Fen",
  );
  try {
    const log = page.getByTestId("message-log");
    const members = page.getByRole("complementary", { name: "Members" });
    rush.send("JCH", { channel: CHANNEL_KEY });
    await expect(members.getByText("Rush Fen")).toBeVisible({
      timeout: 15_000,
    });
    // Zero-padded so `includes("drift 0007")` never matches "drift 0070".
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      rush.send("MSG", {
        channel: CHANNEL_KEY,
        message: `drift ${String(i).padStart(4, "0")}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`drift ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Reload so the live buffer is dropped: the reattached log backfills only
    // the latest REST page, so older history is genuinely paged in FROM THE
    // SERVER on scroll-up rather than already resident.
    await page.reload();
    await expect(
      log.getByText(`drift ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Walk up through several server pages. Each pass scrolls to the top of the
    // loaded content (which fires the next older page) and then samples a
    // mid-viewport anchor row EVERY FRAME from that instant until the page has
    // landed and the loading note has cleared. The anchor's viewport position
    // must never deviate from its pre-load baseline by more than a couple px —
    // no in-flight shove, no post-prepend snap.
    for (let pageLoad = 0; pageLoad < 3; pageLoad += 1) {
      const result = await log.evaluate(async (el) => {
        const logTop = () => el.getBoundingClientRect().top;
        const raf = () =>
          new Promise<void>((r) => requestAnimationFrame(() => r()));
        // Viewport-top offset of a given message row, or null if not rendered.
        const topOf = (text: string) => {
          for (const row of el.querySelectorAll("[data-index]")) {
            if ((row.textContent ?? "").includes(text)) {
              return row.getBoundingClientRect().top - logTop();
            }
          }
          return null;
        };
        // A message sitting well inside the viewport (~250px down): its unique
        // number re-finds it after the load, and the whole loaded block shifts
        // rigidly, so a working anchor pin leaves it exactly where it was.
        const TARGET_TOP = 250;
        const pickAnchor = () => {
          let best: { text: string; top: number; dist: number } | undefined;
          for (const row of el.querySelectorAll("[data-index]")) {
            const match = /drift \d{4}/.exec(row.textContent ?? "");
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
        // older block in. The loading note appears synchronously (before the
        // async page arrives); the prepend lands a few frames later.
        el.scrollTop = 0;
        await raf();
        await raf();

        // The anchor and its true pre-load baseline, captured before the load
        // begins to grow the content.
        const anchor = pickAnchor();
        if (!anchor) {
          return { prepended: false, maxDev: -1, samples: 0 } as const;
        }
        const baseline = anchor.top;

        let maxDev = 0;
        let samples = 0;
        let prepended = false;
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const tick = () => {
            if (el.scrollHeight > heightBefore + 200) {
              prepended = true;
            }
            const top = topOf(anchor.text);
            if (top !== null) {
              maxDev = Math.max(maxDev, Math.abs(top - baseline));
              samples += 1;
            }
            // Run until the page has landed AND the loading note has cleared and
            // the layout has had a moment to rest — or a generous time budget.
            const noteGone = !(el.textContent ?? "").includes("Loading older");
            const done =
              (prepended && noteGone && performance.now() - start > 400) ||
              performance.now() - start > 6000;
            if (done) {
              resolve();
            } else {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        });

        return { prepended, maxDev, samples } as const;
      });

      // A real older page must have prepended, else the assertion is vacuous.
      expect(result.prepended).toBe(true);
      expect(result.samples).toBeGreaterThan(5);
      // The reading position held steady across the entire fetch — no in-flight
      // shove from the loading note, no post-prepend snap.
      expect(result.maxDev).toBeLessThanOrEqual(TRANSIENT_TOLERANCE_PX);
    }

    // The oldest message is still reachable and the jump home lands cleanly.
    await expect(async () => {
      await log.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(log.getByText("drift 0001", { exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(
      log.getByText(`drift ${String(SEED_COUNT).padStart(4, "0")}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    rush.close();
  }
});
