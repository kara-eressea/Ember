// A link's caption is body text and wraps like it (#516).
//
// The chip used to be an `inline-flex` box, which is an atomic inline: it could
// not break, so a long `[url=…]caption[/url]` was ellipsised to one line — a
// sentence cut off mid-word ("…done in this s…") so the ↗ glyph and the [host]
// tag could stay on its row. The caption is the message; the chip is decoration.
//
// This can only be asserted by measuring, and only on a real engine: the claim
// is about where line boxes fall, and jsdom has none. `getClientRects()` gives
// an inline element one rect per line fragment, which is the whole test —
// how many lines the caption took, and whether the host tag ended up on the
// last of them.
//
// Both lengths, because the two failure modes are opposite: a long caption that
// refuses to wrap (the bug) and a short one whose chip drops to a lonely row of
// its own (the obvious over-correction).
//
// Owns vellum@example.test (Vellum Prine) and the Vellum Reading Room: spec
// files run in parallel and a character holds one sim connection, so specs
// share neither (world.ts). No partner — the character writes both links.

import type { Locator } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  test,
} from "./helpers.js";

const ROOM = "ADH-516linkwrap55ee66ff";
const ROOM_TITLE = "Vellum Reading Room";
const HREF = "https://example.test/reading/room";

/** Long enough to need several lines at any log width the suite runs at. */
const LONG_CAPTION =
  "the whole of the thing we were talking about earlier, written out at " +
  "the length it deserves rather than the length that happens to fit on one " +
  "line beside a little arrow and the name of the site it came from";
const SHORT_CAPTION = "the notes";

/** What the chip's geometry says. `getClientRects()` returns one rect per line
 * box an inline element occupies, so the caption's count is how many lines it
 * took. Which line the ↗ and the [host] tag landed on is read from vertical
 * centres rather than tops: those two are set at 11px against the caption's 14
 * and share a baseline with it, so their boxes sit lower inside the same line
 * by the difference. A centre within half a line pitch is the same line; a
 * whole pitch away is the lonely row this must never produce. */
async function chipGeometry(link: Locator) {
  return link.evaluate((anchor) => {
    const [label, glyph, host] = [...anchor.children];
    // One rect per line box — except that `white-space: pre-wrap` leaves a
    // 3px sliver rect for the space a line broke at, on the SAME line. So the
    // lines are the distinct tops, not the raw rect count.
    const lines = (el: Element) => {
      const byTop = new Map<number, number>();
      for (const rect of el.getClientRects()) {
        byTop.set(Math.round(rect.top), rect.top + rect.height / 2);
      }
      return [...byTop.values()];
    };
    const caption = lines(label!);
    return {
      captionLines: caption.length,
      lastCaptionCentre: caption.at(-1) ?? 0,
      /** Distance between the caption's own line boxes, i.e. one line. */
      pitch: caption.length > 1 ? caption[1]! - caption[0]! : 0,
      glyphCentre: lines(glyph!)[0] ?? 0,
      hostCentre: lines(host!)[0] ?? 0,
      captionText: label?.textContent ?? "",
      hostText: host?.textContent ?? "",
    };
  });
}

test("a long link caption wraps, and the chip stays on its last line (#516)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "vellum@example.test", "Vellum Prine");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const log = page.getByTestId("message-log");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(`[${LONG_CAPTION}](${HREF})`);
  await composer.press("Enter");
  await composer.fill(`[${SHORT_CAPTION}](${HREF})`);
  await composer.press("Enter");

  const links = log.locator(`a[href="${HREF}"]`);
  await expect(links).toHaveCount(2, { timeout: 15_000 });

  const long = await chipGeometry(links.first());
  const short = await chipGeometry(links.last());

  // The caption is all there — the ellipsis used to eat the end of it — and it
  // is laid out over several lines rather than one clipped one.
  expect(long.captionText).toBe(LONG_CAPTION);
  expect(
    long.captionLines,
    `the long caption rendered on ${String(long.captionLines)} line(s)`,
  ).toBeGreaterThan(1);
  // …and the decoration followed it down rather than dropping below the block:
  // both sit on the caption's last line.
  const sameLine = long.pitch / 2;
  expect(sameLine).toBeGreaterThan(4);
  expect(
    Math.abs(long.glyphCentre - long.lastCaptionCentre),
  ).toBeLessThanOrEqual(sameLine);
  expect(
    Math.abs(long.hostCentre - long.lastCaptionCentre),
  ).toBeLessThanOrEqual(sameLine);
  expect(long.hostText).toBe("[example.test]");

  // The short one is one line with the chip beside it, which is what it always
  // looked like and must go on looking like. Same log, same type, so the long
  // caption's line pitch is the right yardstick here too.
  expect(short.captionText).toBe(SHORT_CAPTION);
  expect(short.captionLines).toBe(1);
  expect(
    Math.abs(short.glyphCentre - short.lastCaptionCentre),
  ).toBeLessThanOrEqual(sameLine);
  expect(
    Math.abs(short.hostCentre - short.lastCaptionCentre),
  ).toBeLessThanOrEqual(sameLine);
});
