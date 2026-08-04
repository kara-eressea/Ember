// The #514 climb harness, shared by the desktop and phone specs.
//
// The bug was that the log fought a reader climbing away from the tail: writes
// gated only on the held bottom-stick intent landed inside the release
// hysteresis and threw the reader back at the newest message, resetting the
// distance they had built up toward the release. So the measurement is a
// TRANSIENT, sampled every animation frame, and the quantity is the log's
// distance from the bottom.
//
// That quantity is the right one for exactly one reason: it is invariant under
// everything the log is allowed to do to itself while someone reads. A history
// page prepends above the reading position and grows scrollHeight and scrollTop
// together; a row measuring taller than the flat estimate does the same through
// the virtualizer's own adjustment. Neither moves the distance from the bottom
// — instrumented, a 24 000px desktop climb across several server pages produced
// no drop over 5px. Only content arriving BELOW the reader (which pushes the
// tail further away, an increase) or a write dragging the view toward the tail
// (a decrease) shows up, and the second is the bug.
//
// The wheel is the driver, not a finger, and that is deliberate: a synthesized
// touch scroll moves this log exactly 0px on CI, established over three rounds
// and recorded in mobile-log-flow.spec's header. The wheel reproduces the
// defect anyway — the mechanism is about the SIZE of each scroll increment
// relative to the 120px release hysteresis, not about which device made it, so
// a small wheel tick is the same wall a finger drag is.

import type { Page } from "@playwright/test";
import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
} from "./helpers.js";

/** Above the e2e sim's msg_flood (50ms) so no line is throttled away. */
const SEED_SPACING_MS = 70;

/** How far the reading position may slip back toward the tail between two
 * consecutive frames. Sub-pixel row geometry and a date divider settling
 * account for a few px; the defect moved it 46px on a desktop viewport and
 * 150px on a phone, every single time, so this sits clear of both. */
export const TOLERANCE_PX = 40;

/** A long roleplay post: the shape of message this bug needs, because a row
 * that measures many times the virtualizer's flat 26px estimate is what makes
 * 120px of hysteresis a small fraction of one post. */
function roleplayLine(n: number, paragraphs: number): string {
  const body =
    "She set the teacup down with the particular care of someone who has " +
    "decided not to say the first thing that came to mind, and looked at the " +
    "window instead, where the rain had been going on for long enough to stop " +
    "being weather and start being furniture. The room answered with nothing " +
    "at all, which was its habit, and the clock in the hall went on " +
    "subtracting the evening one second at a time until there was very little " +
    "of it left to spend. ";
  return `post ${String(n).padStart(4, "0")}. ${body.repeat(paragraphs)}`;
}

export interface ClimbResult {
  /** How many animation frames were judged. */
  samples: number;
  /** The furthest the reader ever got from the tail, in px. */
  maxDistance: number;
  /** The largest single-frame slip back toward the tail, in px. */
  worstDrop: number;
  /** How many frames slipped back further than TOLERANCE_PX. */
  fights: number;
  /** Where the worst slip happened, for the failure message. */
  worstAt: { from: number; to: number };
}

declare global {
  interface Window {
    __climb?: { distances: number[]; stop: () => void };
  }
}

/** Start sampling the log's distance from the bottom, once per frame. */
async function startSampling(page: Page): Promise<void> {
  await page.getByTestId("message-log").evaluate((el) => {
    const distances: number[] = [];
    let running = true;
    const tick = () => {
      if (!running) {
        return;
      }
      distances.push(el.scrollHeight - el.scrollTop - el.clientHeight);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__climb = {
      distances,
      stop: () => {
        running = false;
      },
    };
  });
}

async function readSamples(page: Page): Promise<ClimbResult> {
  const distances = await page.evaluate(() => {
    window.__climb?.stop();
    return window.__climb?.distances ?? [];
  });
  let worstDrop = 0;
  let worstAt = { from: 0, to: 0 };
  let fights = 0;
  for (let i = 1; i < distances.length; i += 1) {
    const drop = distances[i - 1]! - distances[i]!;
    if (drop > TOLERANCE_PX) {
      fights += 1;
    }
    if (drop > worstDrop) {
      worstDrop = drop;
      worstAt = {
        from: Math.round(distances[i - 1]!),
        to: Math.round(distances[i]!),
      };
    }
  }
  return {
    samples: distances.length,
    maxDistance: Math.round(Math.max(0, ...distances)),
    worstDrop: Math.round(worstDrop),
    fights,
    worstAt,
  };
}

export interface ClimbOptions {
  account: string;
  character: string;
  partnerAccount: string;
  partner: string;
  room: string;
  roomTitle: string;
  /** How many posts to seed. Several REST pages' worth, so the climb crosses
   * real server page boundaries and the prepend path is under test too. */
  seedCount: number;
  /** Paragraphs per post — how tall each row measures at this viewport. */
  paragraphs: number;
  /** Wheel travel per step. Small ON PURPOSE: a step bigger than the 120px
   * release hysteresis frees the reader on its first tick and the bug never
   * shows. This is the finger-sized increment the report is about. */
  wheelPx: number;
  steps: number;
  stepDelayMs: number;
  /** Send a live message every Nth step — the arrival path, whose settle pass
   * is the writer that fought the reader on the desktop viewport. */
  liveEvery?: number;
}

/** Seed a deep backlog of tall posts, climb it with small wheel steps, and
 * report what the reading position did on every frame of the way. */
export async function climbTallHistory(
  page: Page,
  options: ClimbOptions,
): Promise<ClimbResult> {
  await interceptAvatars(page);
  await provisionAndConnect(page, options.account, options.character);
  await joinChannel(page, options.room, options.roomTitle);
  const partner = await SimClient.connect(
    options.partnerAccount,
    "hunter2",
    options.partner,
  );
  try {
    const log = page.getByTestId("message-log");
    partner.send("JCH", { channel: options.room });
    await delay(1500);
    for (let i = 1; i <= options.seedCount; i += 1) {
      partner.send("MSG", {
        channel: options.room,
        message: roleplayLine(i, options.paragraphs),
      });
      await delay(SEED_SPACING_MS);
    }
    const newest = `post ${String(options.seedCount).padStart(4, "0")}.`;
    await expect(log.getByText(newest, { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    // Reload so the live buffer is dropped: the reattached log backfills only
    // the newest REST page, so the older history is genuinely paged in on the
    // way up rather than already resident.
    await page.reload();
    await expect(log.getByText(newest, { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    // Let the open-at-the-tail settle finish before anything is judged — its
    // writes are a deliberate landing, not a fight.
    await delay(2000);
    // Precondition: there is a backlog to climb at all. Without this a log that
    // failed to seed would sail through the assertions by never moving.
    const range = await log.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(range).toBeGreaterThan(2000);

    await startSampling(page);
    await log.hover();
    for (let step = 0; step < options.steps; step += 1) {
      await page.mouse.wheel(0, -options.wheelPx);
      if (
        options.liveEvery !== undefined &&
        step % options.liveEvery === 0 &&
        step > 0
      ) {
        partner.send("MSG", {
          channel: options.room,
          message: roleplayLine(options.seedCount + step, options.paragraphs),
        });
      }
      await delay(options.stepDelayMs);
    }
    await delay(1000);
    return await readSamples(page);
  } finally {
    partner.close();
  }
}
