// #460: a channel whose recent messages are long multi-paragraph roleplay used
// to paint every row on top of every other row for a few hundred milliseconds
// on each visit — the virtualizer lays rows out against a flat 26px estimate
// until it has measured them, and a 400px row placed 26px below its neighbour
// is unreadable soup.
//
// Neither assertion here can be made from a screenshot or a settled DOM: the
// defect is a transient, so the spec samples the log frame by frame from inside
// the page (a rAF loop installed at document start) and judges every frame.
// Two rules, together:
//
//   * no frame in which the REAL rows are painted may contain two rows
//     overlapping by more than a rounding error, and
//   * the skeleton that covers the settle may only be up briefly — otherwise
//     "never paints the soup" would be satisfiable by never painting at all.
//
// Owns loam@example.test (Loam Whitby), burr@example.test (Burr Netherfield)
// and the Long Atelier / Short Corridor rooms: specs never share an account, a
// character or a channel (world.ts).

import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

const ROOM = "ADH-460longatelier55ee66ff";
const ROOM_TITLE = "Long Atelier";
const ASIDE = "ADH-460shortcorridor77aa88bb";
const ASIDE_TITLE = "Short Corridor";

/** Rows are positioned from summed integer measurements while their rects are
 * fractional, so neighbours can touch by a fraction of a pixel. Anything past
 * this is a row sitting on top of another one. */
const MAX_OVERLAP_PX = 3;
/** How long the skeleton may cover the log. Generous next to the handful of
 * frames a settle actually takes, tight enough that a regression to a
 * seconds-long blank fails instead of hiding behind the placeholder. */
const MAX_SKELETON_MS = 1200;
/** The same bound for a revisit, where the remembered heights (the other half
 * of the fix) should make the first layout right and the skeleton a formality. */
const MAX_WARM_SKELETON_MS = 400;

// A window tall and narrow enough that a paragraph wraps hard and the log holds
// a dozen of them: the shape the report describes, and the one the stacking
// needs — at 1280x720 with the same messages the settle finishes in a single
// frame and the defect never reaches the screen.
test.use({ viewport: { width: 940, height: 820 } });

interface LogFrame {
  /** ms since sampling started. */
  at: number;
  /** Rendered rows with a box this frame. */
  rows: number;
  /** Were the real rows painted (as opposed to laid out but hidden)? */
  painted: boolean;
  /** Was the loading skeleton up? */
  skeleton: boolean;
  /** Largest vertical overlap between two rows, in px. */
  worstOverlap: number;
}

declare global {
  interface Window {
    __logFrames?: LogFrame[];
    __startLogSampler?: (durationMs: number) => void;
  }
}

/** Installed at document start, so it is already running when a page load
 * mounts the log.
 *
 * Two loops, deliberately: an animation frame is what the compositor paints, so
 * a rAF sample is the ground truth for "the reader saw this" — but the settle
 * only reaches the screen at all when the main thread is contended enough for
 * the browser to paint between the row growing and React repositioning it. The
 * task loop supplies exactly that contention while sampling the same geometry,
 * and both kinds of sample are judged the same way: whatever was on screen at
 * that instant. On an idle machine the whole settle collapses into one frame and
 * even the unfixed log looks clean, which is why the report is intermittent. */
function installLogSampler(autoStartMs: number): void {
  const frames: LogFrame[] = [];
  window.__logFrames = frames;
  window.__startLogSampler = (durationMs: number) => {
    frames.length = 0;
    const start = performance.now();
    const sample = (): number => {
      const at = performance.now() - start;
      const inner = document.querySelector("[data-testid='message-log-inner']");
      const rects = (inner ? [...inner.querySelectorAll("[data-index]")] : [])
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.height > 0)
        .sort((a, b) => a.top - b.top);
      let worstOverlap = 0;
      for (let i = 1; i < rects.length; i += 1) {
        worstOverlap = Math.max(
          worstOverlap,
          rects[i - 1]!.bottom - rects[i]!.top,
        );
      }
      frames.push({
        at,
        rows: rects.length,
        painted:
          inner !== null && getComputedStyle(inner).visibility !== "hidden",
        skeleton:
          document.querySelector("[data-testid='message-log-skeleton']") !==
          null,
        worstOverlap,
      });
      return at;
    };
    const onFrame = () => {
      if (sample() < durationMs) {
        requestAnimationFrame(onFrame);
      }
    };
    const onTask = () => {
      if (sample() < durationMs) {
        setTimeout(onTask, 0);
      }
    };
    requestAnimationFrame(onFrame);
    setTimeout(onTask, 0);
  };
  if (autoStartMs > 0) {
    window.__startLogSampler(autoStartMs);
  }
}

/** Frames where the reader would have seen rows stacked on one another. */
function soupFrames(frames: LogFrame[]): LogFrame[] {
  return frames.filter(
    (frame) =>
      frame.painted && frame.rows > 1 && frame.worstOverlap > MAX_OVERLAP_PX,
  );
}

/** How long the skeleton was up, first sighting to last. */
function skeletonSpanMs(frames: LogFrame[]): number {
  const covered = frames.filter((frame) => frame.skeleton);
  if (covered.length === 0) {
    return 0;
  }
  return covered.at(-1)!.at - covered[0]!.at;
}

/** Six to twelve wrapped lines per row against a 26px estimate — the 10–40x
 * ratio the report is about, and measurably where the stacking starts: at half
 * this length the same switch settles inside one frame and paints nothing wrong
 * even unfixed. Varied so no uniform-height accident can hide it. */
function roleplayLine(n: number): string {
  const paragraph =
    "The rain had been going since before dawn, and by the time the shutters " +
    "were open the whole yard smelled of wet stone and bruised leaves. She " +
    "set the lamp down on the sill, turned it low, and waited for the wick to " +
    "settle before she said anything at all. ";
  return `L#${String(n)} ${paragraph.repeat(3 + (n % 4))}`;
}

async function seedLongBacklog(
  partner: SimClient,
  count: number,
): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    partner.send("MSG", { channel: ROOM, message: roleplayLine(i) });
    await delay(60);
  }
}

test("switching to a long-message channel never paints stacked rows (#460)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await page.addInitScript(installLogSampler, 0);

  await provisionAndConnect(page, "loam@example.test", "Loam Whitby");
  await joinChannel(page, ASIDE, ASIDE_TITLE);
  await joinChannel(page, ROOM, ROOM_TITLE);

  const burr = await SimClient.connect(
    "burr@example.test",
    "hunter2",
    "Burr Netherfield",
  );
  // The settle is a race between the browser painting a grown row and React
  // repositioning it, and an idle developer laptop wins that race so often that
  // the unfixed log can look clean — which is why the report reads as
  // intermittent. Throttling the switch spreads the pass over frames the way the
  // reporter's machine does. Measured against this spec's own fixture, unfixed:
  // a stacked frame lands on the first trip, 986px of overlap across 16 rows.
  const cdp = await page.context().newCDPSession(page);
  try {
    burr.send("JCH", { channel: ROOM });
    await delay(500);

    const nav = page.getByRole("navigation");
    const log = page.getByTestId("message-log");
    await seedLongBacklog(burr, 40);
    await expect(log.getByText("L#40", { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    // Step out, then come back — the reporter's exact gesture. The buffer is
    // already in the store, so the rows render instantly and only the heights
    // have to be worked out again: the pure measurement case. Three round trips,
    // because one bad frame is easy to explain away.
    for (let trip = 1; trip <= 3; trip += 1) {
      await nav.getByRole("link", { name: ASIDE_TITLE }).click();
      await expect(
        page.getByRole("heading", { name: ASIDE_TITLE }),
      ).toBeVisible();
      await delay(400);

      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
      await page.evaluate((ms) => {
        window.__startLogSampler?.(ms);
      }, 2000);
      await nav.getByRole("link", { name: ROOM_TITLE }).click();
      await delay(2500);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

      const frames = await page.evaluate(() => window.__logFrames ?? []);
      expect(frames.length).toBeGreaterThan(30);
      expect({
        trip,
        soup: soupFrames(frames).map((frame) => ({
          at: Math.round(frame.at),
          overlap: Math.round(frame.worstOverlap),
          rows: frame.rows,
        })),
      }).toEqual({ trip, soup: [] });
      // The other half of the bargain: the log came back, and came back fast.
      // Remembered heights are what make this bound reachable — without them the
      // first layout is wrong and the settle has to walk it back.
      expect(skeletonSpanMs(frames)).toBeLessThan(MAX_WARM_SKELETON_MS);
      expect(frames.some((frame) => frame.painted && frame.rows > 1)).toBe(
        true,
      );
      await expect(log.getByText("L#40", { exact: false })).toBeVisible();
    }
  } finally {
    burr.close();
  }
});

test("a cold load shows skeleton rows while the log measures (#460)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "loam@example.test", "Loam Whitby");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const burr = await SimClient.connect(
    "burr@example.test",
    "hunter2",
    "Burr Netherfield",
  );
  try {
    burr.send("JCH", { channel: ROOM });
    await delay(500);

    const log = page.getByTestId("message-log");
    await seedLongBacklog(burr, 30);
    await expect(log.getByText("L#30", { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    // A page load is the coldest start there is: no store, no remembered
    // heights, the backlog fetched over REST. The sampler goes in before the
    // document runs so the very first mounted frame is recorded.
    await page.addInitScript(installLogSampler, 15_000);
    await page.reload();
    await expect(page.getByRole("heading", { name: ROOM_TITLE })).toBeVisible({
      timeout: 30_000,
    });
    await expect(log.getByText("L#30", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await delay(1500);

    const frames = await page.evaluate(() => window.__logFrames ?? []);
    // The skeleton is user-visible UI now, not just an internal gate: a cold
    // load of a long channel must actually show it rather than a blank panel.
    expect(frames.filter((frame) => frame.skeleton).length).toBeGreaterThan(1);
    expect(skeletonSpanMs(frames)).toBeLessThan(MAX_SKELETON_MS);
    expect(
      soupFrames(frames).map((frame) => ({
        at: Math.round(frame.at),
        overlap: Math.round(frame.worstOverlap),
        rows: frame.rows,
      })),
    ).toEqual([]);
  } finally {
    burr.close();
  }
});
