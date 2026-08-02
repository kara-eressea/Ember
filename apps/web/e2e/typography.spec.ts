// Rendered-CSS regressions for two typography bugs that each survived a first
// round of fixes (#408 composer caret, #409 sender-name sizes). Both are
// cascade/metrics problems that only exist once a real engine has resolved the
// styles — jsdom can't evaluate CSS modules at all (see MessageFontSize.test),
// so every assertion here reads computed style or measures painted pixels.
// Owns flint@example.test (Flint Barrow, Marwenna Wolfhammers) and the
// NPC-free Typesetting room: spec files run in parallel, so specs never share
// accounts (a new ticket invalidates all previous ones account-wide).

import { readFile } from "node:fs/promises";
import type { Browser, Locator, Page } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  test,
} from "./helpers.js";

/** A caret is painted from the font's em box, not from the CSS line-height —
 * which is why #408's line-height rounding never touched it. In the composer's
 * 20px line box, IBM Plex Sans at 13.5px paints 18px; the browser's monospace
 * UA font, which the textarea silently fell back to, painted 15. The floor
 * leaves a pixel of platform rounding and still catches that. */
const MIN_CARET_PX = 17;

interface Box {
  top: number;
  height: number;
  width: number;
}

/**
 * The *painted* caret's box, measured off the compositor: a caret has no
 * element to query. Playwright hides the caret for screenshots by default, so
 * a default shot and a `caret: "initial"` shot of the same focused composer
 * differ in the caret and nothing else. Blink phase is defeated by keeping the
 * tallest diff across a handful of frames.
 */
async function caretBox(page: Page, target: Locator): Promise<Box> {
  const baseline = (await target.screenshot()).toString("base64");
  let best: Box | undefined;
  for (let frame = 0; frame < 14; frame += 1) {
    const shot = (await target.screenshot({ caret: "initial" })).toString(
      "base64",
    );
    const box = await page.evaluate(diffBox, { a: baseline, b: shot });
    if (box && (!best || box.height > best.height)) {
      best = box;
    }
    await page.waitForTimeout(60);
  }
  if (!best) {
    throw new Error("no caret was painted in any frame");
  }
  return best;
}

/** Runs in the page: bounding box of the pixels two PNGs disagree on. */
const diffBox = async ({ a, b }: { a: string; b: string }) => {
  const pixels = async (data: string) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  };
  const [one, two] = await Promise.all([pixels(a), pixels(b)]);
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (let y = 0; y < one.height; y += 1) {
    for (let x = 0; x < one.width; x += 1) {
      const i = (y * one.width + x) * 4;
      const delta =
        Math.abs(one.data[i]! - two.data[i]!) +
        Math.abs(one.data[i + 1]! - two.data[i + 1]!) +
        Math.abs(one.data[i + 2]! - two.data[i + 2]!);
      if (delta > 24) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return bottom < 0
    ? undefined
    : { top, height: bottom - top + 1, width: right - left + 1 };
};

/** The message-font ramp, as the Appearance pane spells it (FONT_RAMP_PX). */
const FONT_STEPS = [
  ["S", 13],
  ["M", 14],
  ["L", 15],
] as const;

function computed(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

async function fontSize(target: Locator): Promise<number> {
  return Number.parseFloat(await computed(target, "font-size"));
}

/** Preferences → Appearance, act, Escape. */
async function inAppearancePrefs(
  page: Page,
  act: (prefs: Locator) => Promise<void>,
): Promise<void> {
  await page.getByRole("button", { name: "Preferences" }).click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await prefs.getByRole("button", { name: "Appearance" }).click();
  await act(prefs);
  await page.keyboard.press("Escape");
  await expect(prefs).not.toBeVisible();
}

/** Layout geometry, read straight off the box — `visibility: hidden` elements
 * still have one, which is the whole point of the grouped-row placeholder. */
function boxWidth(target: Locator): Promise<number> {
  return target.evaluate((el) => el.getBoundingClientRect().width);
}

function leftEdge(target: Locator): Promise<number> {
  return target.evaluate((el) => el.getBoundingClientRect().x);
}

async function setMessageFontSize(page: Page, step: string): Promise<void> {
  await inAppearancePrefs(page, async (prefs) => {
    await prefs
      .getByRole("radiogroup", { name: "Message font size" })
      .getByRole("radio", { name: step, exact: true })
      .click();
  });
}

test("sender names render one type ramp across chat and roll lines", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "flint@example.test", "Flint Barrow");
  await joinChannel(page, "Typesetting", "Typesetting");

  const log = page.getByTestId("message-log");
  const input = page.getByLabel("Message", { exact: true });
  await input.click();
  await page.keyboard.type("a plain chat line");
  await page.keyboard.press("Enter");
  await expect(log.getByText("a plain chat line")).toBeVisible({
    timeout: 10_000,
  });
  // 1d1 is deterministic — this measures type, not luck.
  await page.keyboard.type("/roll 1d1");
  await page.keyboard.press("Enter");
  const rollLine = page.getByTestId("roll-line");
  await expect(rollLine).toBeVisible({ timeout: 10_000 });

  const chatName = log.getByRole("button", { name: "Flint Barrow" }).first();
  const body = log.getByText("a plain chat line");
  // The roller's name is the name-only run inside the server-rendered die
  // line — a [b] span per the documented RLL sample, a [user] button where
  // the server sends one. Either way it must not read a step off the gutter
  // names above it.
  const rollName = rollLine
    .locator("span, button")
    .filter({ hasText: /^Flint Barrow$/ })
    .first();

  for (const [step, expectedPx] of FONT_STEPS) {
    await setMessageFontSize(page, step);

    // Every sender name is the message font, whatever row it sits in: the
    // bug was .nameButton's `font: inherit` beating .nick, which left the
    // chat name on the 13px body default while the roll name tracked
    // --eb-msg-font (14px at the default pref).
    await expect.poll(async () => fontSize(chatName)).toBe(expectedPx);
    expect(await fontSize(rollName)).toBe(expectedPx);
    expect(Number.parseFloat(await computed(log, "--eb-msg-font"))).toBe(
      expectedPx,
    );
    // …and the name is the body's own type, not a face of its own: same
    // family, same weight, colour doing all the distinguishing (user's call,
    // 2026-08-01 — see .nick in chat.module.css). Asserted against the body
    // rather than against literal "IBM Plex Sans"/400, so this keeps meaning
    // "one treatment" if the body face is ever restyled.
    expect(await computed(chatName, "font-family")).toBe(
      await computed(body, "font-family"),
    );
    expect(await computed(chatName, "font-weight")).toBe(
      await computed(body, "font-weight"),
    );
  }
});

// The type assertions above were blind to layout, and their fixture name is
// short — so when #434 changed .nick's font, the aligned layout's 132px name
// column (a px number tuned for the *old* font) silently started ellipsizing
// ordinary names. This test measures the column instead of the glyphs: a
// longest-plausible name must be painted whole at every step of the ramp.
test("a full-length name fits the aligned name column at every font step", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "flint@example.test", "Marwenna Wolfhammers");
  await joinChannel(page, "Typesetting", "Typesetting");

  await inAppearancePrefs(page, async (prefs) => {
    await prefs.getByRole("switch", { name: "Aligned columns" }).click();
    await prefs
      .getByRole("switch", { name: "Group consecutive messages" })
      .click();
  });

  const log = page.getByTestId("message-log");
  const input = page.getByLabel("Message", { exact: true });
  await input.click();
  await page.keyboard.type("a line with a sender");
  await page.keyboard.press("Enter");
  await expect(log.getByText("a line with a sender")).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.type("and its grouped follow-up");
  await page.keyboard.press("Enter");
  await expect(log.getByText("and its grouped follow-up")).toBeVisible({
    timeout: 10_000,
  });

  const nick = log
    .getByRole("button", { name: "Marwenna Wolfhammers" })
    .first();
  // The grouped row's placeholder: same name, hidden, holding the column open.
  const placeholder = log
    .locator('span[aria-hidden="true"]')
    .filter({ hasText: /^Marwenna Wolfhammers$/ })
    .first();
  await expect(placeholder).toBeAttached();

  const widths: number[] = [];
  for (const [step, expectedPx] of FONT_STEPS) {
    await setMessageFontSize(page, step);
    await expect.poll(async () => fontSize(nick)).toBe(expectedPx);

    // The whole name is painted. scrollWidth outgrowing clientWidth is exactly
    // what an ellipsis is drawn from, so this fails on a single clipped glyph.
    const column = await nick.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      width: el.getBoundingClientRect().width,
    }));
    expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth);
    widths.push(column.width);

    // Columns stay put: the invisible placeholder is the same box as the
    // visible name, so both rows' bodies start at the same x.
    expect(await boxWidth(placeholder)).toBeCloseTo(column.width, 1);
    expect(
      await leftEdge(log.getByText("and its grouped follow-up")),
    ).toBeCloseTo(await leftEdge(log.getByText("a line with a sender")), 1);
  }

  // The regression in one assertion: the column is font-relative, so it grows
  // with the ramp instead of standing still while the glyphs get wider.
  expect(widths[1]).toBeGreaterThan(widths[0]!);
  expect(widths[2]).toBeGreaterThan(widths[1]!);

  // …and the ellipsis is still armed for anything past the cap.
  const beyondCap = await nick.evaluate((el) => {
    const original = el.textContent;
    el.textContent = "Marwenna Wolfhammers Of The Longer Name";
    const clipped = el.scrollWidth > el.clientWidth;
    const { textOverflow, overflowX } = getComputedStyle(el);
    el.textContent = original;
    return { clipped, textOverflow, overflowX };
  });
  expect(beyondCap).toEqual({
    clipped: true,
    textOverflow: "ellipsis",
    overflowX: "hidden",
  });
});

test("the empty composer's caret fills the line box in both input modes", async ({
  page,
  browserName,
}) => {
  // Gecko never paints the caret into a Playwright screenshot, so caretBox()
  // measures nothing there — Firefox gets the video-based tests at the bottom
  // of this file instead.
  test.skip(
    browserName !== "chromium",
    "screenshot caret diffing is Blink-only",
  );
  test.setTimeout(120_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "flint@example.test", "Flint Barrow");
  await joinChannel(page, "Typesetting", "Typesetting");

  // ── The classic textarea ──────────────────────────────────────────────
  const textarea = page.getByLabel("Message", { exact: true });
  await textarea.click();
  await expect(textarea).toBeFocused();
  // The bug: with no font-family the textarea ran on the browser's monospace
  // UA font, and a caret is sized from font metrics — not from the line-height
  // #408 rounded to 20px — so it painted 15px tall in a 20px box.
  const emptyTextarea = await caretBox(page, textarea);
  expect(emptyTextarea.height).toBeGreaterThanOrEqual(MIN_CARET_PX);
  await page.keyboard.type("x");
  // Nothing about an empty composer may shrink the caret it shows when typing.
  expect(emptyTextarea.height).toBeGreaterThanOrEqual(
    (await caretBox(page, textarea)).height,
  );
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");

  // ── The inline (CodeMirror) composer, whose empty document is a bare
  //    placeholder widget with no text node for the caret to size from ──
  await page.getByRole("button", { name: "Preferences" }).click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await prefs
    .getByRole("switch", { name: "Style formatting as you type" })
    .click();
  await page.keyboard.press("Escape");
  await expect(prefs).not.toBeVisible();
  await expect(page.getByTestId("inline-composer")).toBeVisible();

  const editor = page.getByLabel("Message", { exact: true });
  await editor.click();
  await expect(editor).toBeFocused();
  const emptyEditor = await caretBox(page, editor);
  expect(emptyEditor.height).toBeGreaterThanOrEqual(MIN_CARET_PX);
  await page.keyboard.type("x");
  expect(emptyEditor.height).toBeGreaterThanOrEqual(
    (await caretBox(page, editor)).height,
  );
});

// ── Firefox ─────────────────────────────────────────────────────────────────
// The same caret, measured the only way Gecko allows. Playwright screenshots
// go through Gecko's snapshot path, which never draws the caret layer, so the
// diff above returns nothing at all in Firefox — a screenshot with the caret
// showing and one with it hidden are byte-identical. A recorded video does
// carry it, so these tests film the blink and read it back. That is why the
// caret could regress in Firefox unseen while Chromium-only CI stayed green.

/** Runs in the page: decodes a recorded video and returns the bbox, within
 * `region`, of pixels whose luminance swings between samples. Everything on a
 * settled composer holds still except the blinking caret. Lossy VP8 smears the
 * edges by a pixel or so, which can only make the box bigger — a caret that
 * fails MIN_CARET_PX here is genuinely short. */
const swingBox = async ({
  data,
  region,
}: {
  data: string;
  region: { x: number; y: number; width: number; height: number };
}) => {
  const video = document.querySelector("video")!;
  video.src = `data:video/webm;base64,${data}`;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => {
      reject(new Error("the recorded video did not decode"));
    };
  });
  const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const count = region.width * region.height;
  const low = new Float64Array(count).fill(Infinity);
  const high = new Float64Array(count).fill(-Infinity);
  // The tail of the recording: the composer has been focused and idle since
  // long before it, and one second covers a full blink cycle.
  for (
    let time = Math.max(0, video.duration - 1.6);
    time < video.duration - 0.1;
    time += 0.05
  ) {
    video.currentTime = time;
    await new Promise((resolve) => (video.onseeked = resolve));
    context.drawImage(video, 0, 0);
    const frame = context.getImageData(
      region.x,
      region.y,
      region.width,
      region.height,
    );
    for (let i = 0; i < count; i += 1) {
      const luminance =
        frame.data[i * 4]! + frame.data[i * 4 + 1]! + frame.data[i * 4 + 2]!;
      low[i] = Math.min(low[i]!, luminance);
      high[i] = Math.max(high[i]!, luminance);
    }
  }
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const i = y * region.width + x;
      if (high[i]! - low[i]! > 60) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return bottom < 0
    ? undefined
    : { top, height: bottom - top + 1, width: right - left + 1 };
};

/** The painted caret's box, read back out of a finished recording. The video
 * is decoded in a throwaway context of the same browser — no second engine
 * involved. */
async function caretBoxFromVideo(
  browser: Browser,
  file: string,
  region: { x: number; y: number; width: number; height: number },
): Promise<Box> {
  const data = (await readFile(file)).toString("base64");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent("<video></video>");
    const box = await page.evaluate(swingBox, { data, region });
    if (!box) {
      throw new Error("no caret was painted in the recording");
    }
    return box;
  } finally {
    await context.close();
  }
}

test.describe("firefox", () => {
  for (const inline of [false, true]) {
    const mode = inline ? "inline" : "plain";
    test(`the empty ${mode} composer's caret fills the line box in Firefox`, async ({
      page,
      context,
      browser,
      browserName,
    }, testInfo) => {
      test.skip(browserName !== "firefox", "Chromium is measured above");
      test.setTimeout(120_000);
      await interceptAvatars(page);
      // Its own character (the Chromium half of this file can be running at
      // the same time, in another worker), but the same quiet room: these
      // tests never send a line, so the two halves can't disturb each other.
      await provisionAndConnect(page, "kestrel@example.test", "Kestrel Vane");
      await joinChannel(page, "Typesetting", "Typesetting");

      if (inline) {
        await page.getByRole("button", { name: "Preferences" }).click();
        const prefs = page.getByRole("dialog", { name: "Preferences" });
        await prefs
          .getByRole("switch", { name: "Style formatting as you type" })
          .click();
        await page.keyboard.press("Escape");
        await expect(prefs).not.toBeVisible();
        await expect(page.getByTestId("inline-composer")).toBeVisible();
      }

      const input = page.getByLabel("Message", { exact: true });
      await input.click();
      await expect(input).toBeFocused();
      const box = (await input.boundingBox())!;
      // The caret sits on the first column; a narrow strip keeps every other
      // moving pixel in the app out of the measurement.
      const region = {
        x: Math.floor(box.x) - 3,
        y: Math.floor(box.y) - 3,
        width: 30,
        height: Math.ceil(box.height) + 6,
      };
      // Film a few blink cycles with nothing else on screen moving.
      await page.waitForTimeout(2600);

      const video = page.video()!;
      await context.close(); // finalizes the recording
      const file = testInfo.outputPath(`caret-${mode}.webm`);
      await video.saveAs(file);

      const caret = await caretBoxFromVideo(browser, file, region);
      // A caret is a hairline: anything wider means the strip caught something
      // else moving, and the height below would be measuring that instead.
      expect(caret.width).toBeLessThanOrEqual(4);
      expect(caret.height).toBeGreaterThanOrEqual(MIN_CARET_PX);
    });
  }
});
