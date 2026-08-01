// Rendered-CSS regressions for two typography bugs that each survived a first
// round of fixes (#408 composer caret, #409 sender-name sizes). Both are
// cascade/metrics problems that only exist once a real engine has resolved the
// styles — jsdom can't evaluate CSS modules at all (see MessageFontSize.test),
// so every assertion here reads computed style or measures painted pixels.
// Owns flint@example.test (Flint Barrow) and the NPC-free Typesetting room:
// spec files run in parallel, so specs never share accounts (a new ticket
// invalidates all previous ones account-wide).

import type { Locator, Page } from "@playwright/test";
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

function computed(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

async function fontSize(target: Locator): Promise<number> {
  return Number.parseFloat(await computed(target, "font-size"));
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
  // The roller's name is the name-only run inside the server-rendered die
  // line — a [b] span per the documented RLL sample, a [user] button where
  // the server sends one. Either way it must not read a step off the gutter
  // names above it.
  const rollName = rollLine
    .locator("span, button")
    .filter({ hasText: /^Flint Barrow$/ })
    .first();

  for (const [step, expectedPx] of [
    ["S", 13],
    ["M", 14],
    ["L", 15],
  ] as const) {
    await page.getByRole("button", { name: "Preferences" }).click();
    const prefs = page.getByRole("dialog", { name: "Preferences" });
    await prefs.getByRole("button", { name: "Appearance" }).click();
    await prefs
      .getByRole("radiogroup", { name: "Message font size" })
      .getByRole("radio", { name: step, exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(prefs).not.toBeVisible();

    // Every sender name is the message font, whatever row it sits in: the
    // bug was .nameButton's `font: inherit` beating .nick, which left the
    // chat name on the 13px body default while the roll name tracked
    // --eb-msg-font (14px at the default pref).
    await expect.poll(async () => fontSize(chatName)).toBe(expectedPx);
    expect(await fontSize(rollName)).toBe(expectedPx);
    expect(Number.parseFloat(await computed(log, "--eb-msg-font"))).toBe(
      expectedPx,
    );
    // …and .nick's own face and weight survive the button reset.
    expect(await computed(chatName, "font-family")).toContain("IBM Plex Mono");
    expect(await computed(chatName, "font-weight")).toBe("600");
  }
});

test("the empty composer's caret fills the line box in both input modes", async ({
  page,
}) => {
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
