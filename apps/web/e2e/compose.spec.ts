// The M4 verification E2E (milestone-4.md): Markdown preview matches the
// final render, eicons render inline at a fixed size, a delayed send can be
// recalled with ArrowUp, and a reload mid-delay doesn't lose the message
// (the outbox lives server-side). Owns sage@example.test (Sage Willowmere):
// spec files run in parallel, so specs never share characters. Development
// is shared but never member-counted (only chat.spec counts, on Frontpage).

import { expect, test } from "@playwright/test";
import {
  delay,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

test("markdown compose: preview = render, eicons, delayed send + recall", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "sage@example.test", "Sage Willowmere");
  await joinChannel(page, "Development", "Development");

  // exact: the sidebar's "Message a character" DM form would substring-match.
  const input = page.getByLabel("Message", { exact: true });
  const log = page.getByTestId("message-log");

  // ── Preview matches the final render ──────────────────────────────────
  await input.fill("**bold words** and `a code span`");
  const preview = page.getByTestId("md-preview");
  await expect(preview).toBeVisible();
  // The preview renders the translated wire form through the same pipeline
  // as the log: real styling, no literal markers.
  await expect(preview.getByText("bold words", { exact: true })).toBeVisible();
  await expect(preview.getByText("a code span")).toBeVisible();
  await expect(preview).not.toContainText("**");
  await input.press("Enter");
  await expect(log.getByText("bold words", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(log.getByText("a code span")).toBeVisible();
  await expect(log).not.toContainText("**bold words**");

  // ── Formatting toolbar + /help (#205) ─────────────────────────────────
  // Every promoted action sits on the MessageBox toolbar now. Bold is
  // Markdown-aware; Underline (BBCode-only) works with Markdown on because
  // the dialect passes wrapper tags through.
  await input.fill("glow");
  await input.selectText();
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(input).toHaveValue("**glow**");
  // The wrap restores the inner selection on the next frame — let it land
  // before re-selecting everything, or it would override selectText().
  await delay(150);
  await input.selectText();
  await page.getByRole("button", { name: "Underline" }).click();
  await expect(input).toHaveValue("[u]**glow**[/u]");
  await input.fill("/help");
  await input.press("Enter");
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(help).toBeVisible();
  await expect(help.getByText("/setmode chat|ads|both")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).not.toBeVisible();
  await expect(input).toHaveValue("");

  // ── Eicons render inline at a fixed 60px box ───────────────────────────
  await input.fill("look: [eicon]teacup[/eicon]");
  await input.press("Enter");
  const eicon = log.getByRole("img", { name: "teacup" });
  await expect(eicon).toBeVisible({ timeout: 10_000 });
  await expect(eicon).toHaveAttribute("width", "60");
  await expect(eicon).toHaveAttribute("height", "60");

  // ── EiconPicker (M8 step 11): ☺ popover, Recents → star → Favorites ───
  // The typed eicon above was recorded as "used", so Recents bootstraps
  // without search (which ships disabled until step 12).
  await page.getByRole("button", { name: "Eicon", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Eicon picker" });
  await expect(picker).toBeVisible();
  await expect(picker.getByText("No favorites yet")).toBeVisible();
  await picker.getByRole("tab", { name: "Recents" }).click();
  await expect(
    picker.getByRole("button", { name: "Insert teacup" }),
  ).toBeVisible();
  await picker.getByRole("button", { name: "Add teacup to favorites" }).click();
  await picker.getByRole("tab", { name: "Favorites" }).click();
  await expect(
    picker.getByRole("button", { name: "Remove teacup from favorites" }),
  ).toBeVisible();
  // Search is pref-gated (server-enforced): the disabled explainer links to
  // Preferences, where the toggle carries the third-party disclosure.
  await picker.getByRole("tab", { name: /Search/ }).click();
  await expect(picker.getByText("Eicon search is off")).toBeVisible();
  await picker.getByRole("button", { name: /Enable in Preferences/ }).click();
  const prefsWindow = page.getByRole("dialog", { name: "Preferences" });
  await expect(prefsWindow).toBeVisible();
  await prefsWindow.getByRole("button", { name: "Appearance" }).click();
  await prefsWindow.getByRole("switch", { name: "Eicon search" }).click();
  await page.keyboard.press("Escape");
  await expect(prefsWindow).not.toBeVisible();
  // Live search against the sim-served xariah-format index.
  await page.getByRole("button", { name: "Eicon", exact: true }).click();
  await picker.getByRole("tab", { name: "Search" }).click();
  await picker.getByRole("textbox", { name: "Search eicons" }).fill("lantern");
  await expect(
    picker.getByRole("button", { name: "Insert lanternlight" }),
  ).toBeVisible();
  // Tile click inserts at the caret; Escape dismisses the popover.
  await picker.getByRole("tab", { name: "Favorites" }).click();
  await picker.getByRole("button", { name: "Insert teacup" }).click();
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(input).toHaveValue("[eicon]teacup[/eicon]");
  await input.fill("");

  // ── Link previews (M8 step 13): media chip → floating panel ────────────
  // The image URL rides the intercepted static.f-list.net host, so the
  // preview loads the fixture PNG; default mode is click.
  await input.fill(
    "see https://static.f-list.net/images/charimage/999.png and https://example.com/article",
  );
  await input.press("Enter");
  const mediaChip = log.getByRole("link", { name: /999\.png/ });
  await expect(mediaChip).toBeVisible({ timeout: 10_000 });
  await expect(mediaChip).toContainText("▣");
  // Even a previewable chip keeps its real href — modified clicks and
  // open-in-new-tab always have somewhere to go (decisions.md §14).
  await expect(mediaChip).toHaveAttribute(
    "href",
    "https://static.f-list.net/images/charimage/999.png",
  );
  // Ordinary web links stay plain navigation (↗ glyph, real href).
  const plainChip = log.getByRole("link", { name: /article/ });
  await expect(plainChip).toContainText("↗");
  await expect(plainChip).toHaveAttribute(
    "href",
    "https://example.com/article",
  );
  await mediaChip.click();
  const panel = page.getByRole("dialog", { name: /Preview: static\.f-list/ });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("static.f-list.net/images/charimage/999.png"),
  ).toBeVisible();
  // Escape closes the panel; the message (and log) stayed visible behind it.
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  // Ctrl/Cmd-click is left alone (decisions.md §14): the handler skips
  // preventDefault, so the anchor's target="_blank" default runs and the
  // panel never opens. (Whether headless Chromium actually spawns the tab
  // is browser policy — the app-owned contract is "no preview hijack", and
  // any tab that does open is fed by the context-level intercept.)
  await mediaChip.click({ modifiers: ["ControlOrMeta"] });
  await delay(300);
  await expect(panel).not.toBeVisible();

  // ── Delayed send: Timer popover + pending affordance + recall ─────────
  // The Timer button (toolbar, #205) owns the send delay now: arming it
  // flips the button to the accent-filled treatment with the delay label.
  const timer = page.getByRole("button", { name: "Send timer" });
  await timer.click();
  await page.getByRole("radio", { name: "15 seconds" }).click();
  await expect(timer).toHaveAttribute("aria-pressed", "true");
  await expect(timer).toContainText("15s");
  await input.fill("**recalled** never arrives");
  await input.press("Enter");
  const pending = page.getByTestId("pending-send");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("sending in");
  // ArrowUp in the empty composer pulls it back — as typed, not as BBCode.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("**recalled** never arrives", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("pending-send")).toHaveCount(0);

  // ── Reload mid-delay: the outbox lives server-side ─────────────────────
  await input.fill("survives the reload");
  await input.press("Enter");
  await expect(page.getByTestId("pending-send")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Development" })).toBeVisible({
    timeout: 15_000,
  });
  // The message releases ~15s after the send and lands as a real row.
  await expect(log.getByText("survives the reload")).toBeVisible({
    timeout: 20_000,
  });
  // The recalled message never made it out.
  await expect(log.getByText("recalled")).toHaveCount(0);
});
